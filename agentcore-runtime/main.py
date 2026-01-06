"""
Agent Core Runtime with Bedrock Claude + Tool Use + Memory integration

AWS Bedrock Agent Core Runtime の実装
- Claude Sonnet 4.5 (JP Inference Profile) との連携
- Tool Use (Function Calling) による外部API連携
- AgentCore Memory Gateway による会話永続化
- Code Interpreter による Python コード実行
- ストリーミングレスポンス対応
"""
import json
import logging
from typing import Any
from datetime import datetime
import uuid

import boto3
from botocore.exceptions import ClientError
from bedrock_agentcore.runtime import BedrockAgentCoreApp

# ログ設定
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = BedrockAgentCoreApp()

# AWS クライアントの初期化
bedrock_client = boto3.client('bedrock-runtime', region_name='ap-northeast-1')
service_quotas_client = boto3.client('service-quotas', region_name='ap-northeast-1')
agentcore_client = boto3.client('bedrock-agentcore', region_name='ap-northeast-1')
agentcore_control_client = boto3.client('bedrock-agentcore-control', region_name='ap-northeast-1')

# Claude モデル設定 (JP Inference Profile)
MODEL_ID = "jp.anthropic.claude-sonnet-4-5-20250929-v1:0"

# Memory 設定
MEMORY_NAME = "chat_memory"
_memory_id_cache = None

# システムプロンプト
SYSTEM_PROMPT = """あなたは AWS のエキスパートアシスタントです。
AWS サービスの制限、クォータ、ベストプラクティスについてお答えします。
日本語で丁寧に回答してください。

利用可能なツール:
- get_aws_service_info: AWS Service Quotas API からリアルタイムでクォータ情報を取得
- get_aws_news: AWS の最新ニュース（What's New）を取得
- execute_code: Python コードを実行（計算、データ処理、可視化など）

クォータ情報は get_aws_service_info ツールで取得してください。
ベストプラクティスについては、あなたの知識を元に回答してください。

あなたは長期記憶を持っています。過去の会話から学んだユーザーの好みや重要な情報を覚えていて、
適切な場面で活用してください。"""

# Tool definitions
TOOLS = [
    {
        "name": "get_aws_service_info",
        "description": """AWS Service Quotas API からサービスのクォータ情報をリアルタイムで取得します。
このアカウントの現在の設定値を返します。
対応サービス: Lambda, S3, DynamoDB, API Gateway, SQS, SNS""",
        "input_schema": {
            "type": "object",
            "properties": {
                "service_name": {
                    "type": "string",
                    "description": "AWS サービス名 (例: lambda, s3, dynamodb, api-gateway, sqs, sns)"
                }
            },
            "required": ["service_name"]
        }
    },
    {
        "name": "get_aws_news",
        "description": "AWS の最新ニュース (What's New) を取得します。",
        "input_schema": {
            "type": "object",
            "properties": {
                "limit": {
                    "type": "integer",
                    "description": "取得件数 (デフォルト: 5)",
                    "default": 5
                }
            }
        }
    },
    {
        "name": "execute_code",
        "description": """Python コードを安全なサンドボックス環境で実行します。
Amazon Bedrock AgentCore Code Interpreter を使用。
使用例: 数学的な計算、データ処理、テキスト処理
注意: print() を使って結果を表示してください。""",
        "input_schema": {
            "type": "object",
            "properties": {
                "code": {
                    "type": "string",
                    "description": "実行する Python コード"
                }
            },
            "required": ["code"]
        }
    }
]


# =============================================================================
# Service Quotas Mapping
# =============================================================================

SERVICE_QUOTAS_MAPPING = {
    "lambda": {
        "service_code": "lambda",
        "quotas": [
            ("L-B99A9384", "同時実行数"),
            ("L-E49FF7B8", "デプロイパッケージ (解凍後)"),
            ("L-75F48B05", "デプロイパッケージ (直接アップロード)"),
            ("L-2ACBD22F", "関数とレイヤーのストレージ"),
            ("L-5C4B2C97", "同期ペイロードサイズ"),
            ("L-7C0F49F9", "非同期ペイロードサイズ"),
            ("L-6581F036", "環境変数サイズ"),
        ]
    },
    "dynamodb": {
        "service_code": "dynamodb",
        "quotas": [
            ("L-F98FE922", "テーブル数上限"),
            ("L-F7858A77", "テーブルあたりのGSI数"),
            ("L-AB614373", "テーブルレベル書き込みスループット"),
            ("L-CF0CBE56", "テーブルレベル読み取りスループット"),
            ("L-34F8CCC8", "アカウントレベル書き込みスループット"),
            ("L-34F6A552", "アカウントレベル読み取りスループット"),
        ]
    },
    "s3": {
        "service_code": "s3",
        "quotas": [
            ("L-89BABEE8", "オブジェクトサイズ"),
            ("L-B461D596", "レプリケーションルール数"),
        ]
    },
    "api-gateway": {
        "service_code": "apigateway",
        "quotas": [
            ("L-AA0FF27B", "リージョナルAPI数"),
            ("L-01C8A9E0", "REST/WebSocket APIあたりのリソース数"),
            ("L-46624B39", "APIペイロードサイズ"),
            ("L-E5AE38E3", "統合タイムアウト"),
            ("L-1D180A63", "APIキー数"),
        ]
    },
    "sqs": {
        "service_code": "sqs",
        "quotas": [("L-1F7A8FA6", "キュー数")],
    },
    "sns": {
        "service_code": "sns",
        "quotas": [
            ("L-61103206", "トピック数"),
            ("L-C6E88E4A", "サブスクリプション数/トピック"),
        ]
    },
}


# =============================================================================
# Memory Functions
# =============================================================================

def get_memory_id() -> str:
    """Memory ID を名前から取得（キャッシュ機能付き）"""
    global _memory_id_cache
    if _memory_id_cache:
        return _memory_id_cache

    try:
        response = agentcore_control_client.list_memories()
        for mem in response.get('memories', []):
            mem_id = mem.get('id', '')
            if mem_id.startswith(MEMORY_NAME):
                _memory_id_cache = mem_id
                logger.info(f"Found memory ID: {_memory_id_cache}")
                return _memory_id_cache
        logger.warning(f"Memory with prefix '{MEMORY_NAME}' not found")
        return None
    except Exception as e:
        logger.error(f"Error getting memory ID: {e}")
        return None


def sanitize_actor_id(actor_id: str) -> str:
    """Sanitize actor_id to match AWS pattern"""
    return actor_id.replace('@', '_at_').replace('.', '_')


def save_to_memory(actor_id: str, session_id: str, role: str, content: str):
    """Save a conversation turn to Memory"""
    memory_id = get_memory_id()
    if not memory_id:
        logger.warning("Memory not available, skipping save")
        return

    try:
        memory_role = "USER" if role == "user" else "ASSISTANT"
        safe_actor_id = sanitize_actor_id(actor_id)

        agentcore_client.create_event(
            memoryId=memory_id,
            actorId=safe_actor_id,
            sessionId=session_id,
            eventTimestamp=datetime.utcnow(),
            clientToken=str(uuid.uuid4()),
            payload=[{
                'conversational': {
                    'content': {'text': content},
                    'role': memory_role
                }
            }]
        )
        logger.info(f"Saved to memory: {role} message for actor={safe_actor_id}")
    except Exception as e:
        logger.error(f"Error saving to memory: {e}")


def search_long_term_memory(actor_id: str, query: str, top_k: int = 5) -> str:
    """Search long-term memory for relevant information"""
    memory_id = get_memory_id()
    if not memory_id:
        return ""

    try:
        safe_actor_id = sanitize_actor_id(actor_id)
        namespace_prefix = f"/strategies/summary_builtin_cdkGen0001-a8lhF65myb/actors/{safe_actor_id}"

        response = agentcore_client.retrieve_memory_records(
            memoryId=memory_id,
            namespace=namespace_prefix,
            searchCriteria={'searchQuery': query, 'topK': top_k},
            maxResults=top_k
        )

        results = []
        for record in response.get('memoryRecordSummaries', []):
            content = record.get('content', {})
            text = content.get('text', '') if isinstance(content, dict) else str(content)
            if text:
                results.append(text)

        if results:
            logger.info(f"Found {len(results)} long-term memory records")
            return "\n".join(results)
        return ""
    except Exception as e:
        logger.warning(f"Long-term memory search error: {e}")
        return ""


# =============================================================================
# Tool Functions
# =============================================================================

def fetch_quotas_from_api(service_key: str) -> dict:
    """Fetch quotas from Service Quotas API"""
    if service_key not in SERVICE_QUOTAS_MAPPING:
        return None

    mapping = SERVICE_QUOTAS_MAPPING[service_key]
    service_code = mapping["service_code"]
    quotas = {}

    for quota_code, quota_name_ja in mapping["quotas"]:
        try:
            response = service_quotas_client.get_service_quota(
                ServiceCode=service_code, QuotaCode=quota_code
            )
            quota = response.get("Quota", {})
            value = quota.get("Value", "N/A")
            unit = quota.get("Unit", "")

            if unit == "Megabytes":
                quotas[quota_name_ja] = f"{value} MB"
            elif unit == "Gigabytes":
                quotas[quota_name_ja] = f"{value} GB"
            elif unit == "Terabytes":
                quotas[quota_name_ja] = f"{value} TB"
            elif unit == "Kilobytes":
                quotas[quota_name_ja] = f"{value} KB"
            elif unit == "Milliseconds":
                quotas[quota_name_ja] = f"{value} ms"
            elif unit == "Count":
                quotas[quota_name_ja] = f"{int(value)}"
            else:
                quotas[quota_name_ja] = f"{value}" if unit == "None" else f"{value} {unit}"
        except ClientError as e:
            logger.warning(f"Failed to fetch quota {quota_code}: {e}")
        except Exception as e:
            logger.warning(f"Unexpected error fetching quota {quota_code}: {e}")

    return quotas if quotas else None


def get_aws_service_info(service_name: str) -> dict:
    """Get AWS service quota information from Service Quotas API"""
    service_key = service_name.lower().replace(" ", "-").replace("_", "-")
    service_mapping = {"apigateway": "api-gateway", "api gateway": "api-gateway"}
    service_key = service_mapping.get(service_key, service_key)

    api_quotas = fetch_quotas_from_api(service_key)
    if api_quotas:
        return {"service": service_key, "source": "Service Quotas API", "quotas": api_quotas}
    else:
        return {"error": f"サービス '{service_name}' のクォータ情報を取得できませんでした。対応サービス: {', '.join(SERVICE_QUOTAS_MAPPING.keys())}"}


def get_aws_news(limit: int = 5) -> dict:
    """Get AWS What's New RSS feed"""
    try:
        import feedparser
        feed = feedparser.parse("https://aws.amazon.com/about-aws/whats-new/recent/feed/")
        news_items = []
        for entry in feed.entries[:limit]:
            summary = entry.get("summary", "")
            news_items.append({
                "title": entry.get("title", ""),
                "link": entry.get("link", ""),
                "published": entry.get("published", ""),
                "summary": summary[:200] + "..." if len(summary) > 200 else summary
            })
        return {"count": len(news_items), "items": news_items}
    except ImportError:
        return {"error": "feedparser がインストールされていません", "items": []}
    except Exception as e:
        logger.error(f"Error fetching AWS news: {e}")
        return {"error": f"ニュース取得エラー: {str(e)}", "items": []}


def execute_code(code: str) -> dict:
    """Execute Python code using AgentCore Code Interpreter"""
    session_id = None
    try:
        session_response = agentcore_client.start_code_interpreter_session(
            codeInterpreterIdentifier="aws.codeinterpreter.v1",
            name="code-session",
            sessionTimeoutSeconds=900
        )
        session_id = session_response["sessionId"]
        logger.info(f"Started Code Interpreter session: {session_id}")

        execute_response = agentcore_client.invoke_code_interpreter(
            codeInterpreterIdentifier="aws.codeinterpreter.v1",
            sessionId=session_id,
            name="executeCode",
            arguments={"language": "python", "code": code}
        )

        output_parts, error_parts = [], []
        for event in execute_response.get('stream', []):
            if 'result' in event:
                for content_item in event['result'].get('content', []):
                    if content_item.get('type') == 'text':
                        output_parts.append(content_item.get('text', ''))
                    elif content_item.get('type') == 'error':
                        error_parts.append(content_item.get('text', ''))

        output, errors = '\n'.join(output_parts), '\n'.join(error_parts)
        if errors:
            return {"success": False, "output": output, "error": errors}
        return {"success": True, "output": output if output else "(出力なし)"}

    except ClientError as e:
        error_code = e.response.get('Error', {}).get('Code', 'Unknown')
        error_msg = e.response.get('Error', {}).get('Message', str(e))
        return {"success": False, "error": f"Code Interpreter エラー: {error_code} - {error_msg}"}
    except Exception as e:
        return {"success": False, "error": f"予期せぬエラー: {str(e)}"}
    finally:
        if session_id:
            try:
                agentcore_client.stop_code_interpreter_session(
                    codeInterpreterIdentifier="aws.codeinterpreter.v1", sessionId=session_id
                )
            except Exception:
                pass


def execute_tool(tool_name: str, tool_input: dict) -> Any:
    """Execute a tool and return the result"""
    logger.info(f"Executing tool: {tool_name}")
    if tool_name == "get_aws_service_info":
        return get_aws_service_info(service_name=tool_input.get("service_name", ""))
    elif tool_name == "get_aws_news":
        return get_aws_news(limit=tool_input.get("limit", 5))
    elif tool_name == "execute_code":
        return execute_code(code=tool_input.get("code", ""))
    else:
        return {"error": f"Unknown tool: {tool_name}"}


# =============================================================================
# Claude API Functions
# =============================================================================

def call_claude(messages: list, tools: list = None) -> dict:
    """Call Bedrock Claude with messages and optional tools"""
    try:
        request_body = {
            "anthropic_version": "bedrock-2023-05-31",
            "max_tokens": 4096,
            "system": SYSTEM_PROMPT,
            "messages": messages
        }
        if tools:
            request_body["tools"] = tools

        response = bedrock_client.invoke_model(
            modelId=MODEL_ID, contentType="application/json",
            accept="application/json", body=json.dumps(request_body)
        )
        return json.loads(response['body'].read())
    except ClientError as e:
        logger.error(f"Bedrock API error: {e}")
        raise


def call_claude_streaming(messages: list):
    """Call Bedrock Claude with streaming response"""
    try:
        request_body = {
            "anthropic_version": "bedrock-2023-05-31",
            "max_tokens": 4096,
            "system": SYSTEM_PROMPT,
            "messages": messages
        }
        response = bedrock_client.invoke_model_with_response_stream(
            modelId=MODEL_ID, contentType="application/json",
            accept="application/json", body=json.dumps(request_body)
        )
        for event in response['body']:
            chunk = json.loads(event['chunk']['bytes'])
            if chunk.get('type') == 'content_block_delta':
                delta = chunk.get('delta', {})
                if delta.get('type') == 'text_delta':
                    text = delta.get('text', '')
                    if text:
                        yield text
            elif chunk.get('type') == 'message_stop':
                break
    except ClientError as e:
        logger.error(f"Bedrock streaming API error: {e}")
        raise


def process_conversation_streaming(prompt: str, history: list = None):
    """Process conversation with streaming response and tool use support"""
    messages = []
    if history:
        for msg in history:
            role, content = msg.get("role", "user"), msg.get("content", "")
            if role in ["user", "assistant"] and content:
                messages.append({"role": role, "content": content})
    messages.append({"role": "user", "content": prompt})

    response = call_claude(messages, TOOLS)
    if response.get("stop_reason") != "tool_use":
        for chunk in call_claude_streaming(messages):
            yield chunk
        return

    max_iterations, iteration = 5, 0
    while response.get("stop_reason") == "tool_use" and iteration < max_iterations:
        iteration += 1
        assistant_content = response.get("content", [])
        messages.append({"role": "assistant", "content": assistant_content})

        tool_results = []
        for block in assistant_content:
            if block.get("type") == "tool_use":
                tool_name, tool_input, tool_id = block.get("name"), block.get("input", {}), block.get("id")
                yield f"[ツール実行中: {tool_name}]\n"
                result = execute_tool(tool_name, tool_input)
                tool_results.append({"type": "tool_result", "tool_use_id": tool_id, "content": json.dumps(result, ensure_ascii=False)})

        messages.append({"role": "user", "content": tool_results})
        response = call_claude(messages, TOOLS)

    for chunk in call_claude_streaming(messages):
        yield chunk


# =============================================================================
# Agent Handler
# =============================================================================

@app.entrypoint
async def agent_handler(request: dict):
    """Agent Core Runtime handler"""
    prompt = request.get('prompt', '')
    session_id = request.get('sessionId', '')
    actor_id = request.get('actorId', 'default-user')
    history = request.get('history', [])

    if not prompt:
        yield "こんにちは！AWS についてのご質問をお待ちしています。"
        return

    try:
        save_to_memory(actor_id, session_id, "user", prompt)
        long_term_context = search_long_term_memory(actor_id, prompt)
        enhanced_history = []

        if long_term_context:
            enhanced_history.append({"role": "assistant", "content": f"[過去の会話から覚えていること]\n{long_term_context}"})
        if history:
            enhanced_history.extend(history)

        response_chunks = []
        for chunk in process_conversation_streaming(prompt, enhanced_history):
            response_chunks.append(chunk)
            yield chunk

        full_response = "".join(response_chunks)
        if full_response:
            save_to_memory(actor_id, session_id, "assistant", full_response)

    except ClientError as e:
        error_code = e.response.get('Error', {}).get('Code', 'Unknown')
        if error_code == 'AccessDeniedException':
            yield "Bedrock モデルへのアクセス権限がありません。"
        elif error_code == 'ThrottlingException':
            yield "リクエストが制限されています。しばらく待ってください。"
        else:
            yield f"AWS API エラー: {error_code}"
    except Exception as e:
        logger.error(f"Unexpected error: {e}")
        yield "エラーが発生しました。しばらく待ってから再度お試しください。"


if __name__ == "__main__":
    app.run()
