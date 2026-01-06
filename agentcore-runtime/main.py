"""
Agent Core Runtime with Bedrock Claude + Streaming

AWS Bedrock Agent Core Runtime の最小構成
- Claude Sonnet 4.5 (JP Inference Profile) との連携
- 会話履歴のサポート
- ストリーミングレスポンス対応
"""
import json
import logging

import boto3
from botocore.exceptions import ClientError
from bedrock_agentcore.runtime import BedrockAgentCoreApp

# ログ設定
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = BedrockAgentCoreApp()

# AWS クライアントの初期化
bedrock_client = boto3.client('bedrock-runtime', region_name='ap-northeast-1')

# Claude モデル設定 (JP Inference Profile)
MODEL_ID = "jp.anthropic.claude-sonnet-4-5-20250929-v1:0"

# システムプロンプト
SYSTEM_PROMPT = """あなたは AWS のエキスパートアシスタントです。
AWS サービスの制限、クォータ、ベストプラクティスについてお答えします。
日本語で丁寧に回答してください。"""


# =============================================================================
# Claude API Functions
# =============================================================================

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
            modelId=MODEL_ID,
            contentType="application/json",
            accept="application/json",
            body=json.dumps(request_body)
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


# =============================================================================
# Agent Handler
# =============================================================================

@app.entrypoint
async def agent_handler(request: dict):
    """Agent Core Runtime handler"""
    prompt = request.get('prompt', '')
    history = request.get('history', [])

    if not prompt:
        yield "こんにちは！AWS についてのご質問をお待ちしています。"
        return

    # Build messages with history
    messages = []
    if history:
        for msg in history:
            role, content = msg.get("role", "user"), msg.get("content", "")
            if role in ["user", "assistant"] and content:
                messages.append({"role": role, "content": content})
    messages.append({"role": "user", "content": prompt})

    try:
        for chunk in call_claude_streaming(messages):
            yield chunk
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
