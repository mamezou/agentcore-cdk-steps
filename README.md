# AWS Bedrock AgentCore CDK Steps

AWS Bedrock AgentCore を段階的に学べるチュートリアルリポジトリです。

## アーキテクチャ

```
┌─────────────┐     ┌──────────────────────────────────────────────────────┐
│   Frontend  │────▶│              Bedrock AgentCore                       │
│   (React)   │     │  ┌────────────────────────────────────────────────┐  │
│   + Cognito │     │  │  Agent Runtime (Docker)                        │  │
│             │     │  │  - Claude Sonnet 4.5 (JP Inference Profile)    │  │
│             │     │  │  - Custom Tools:                               │  │
│             │     │  │    - get_aws_service_info (Service Quotas API) │  │
│             │     │  │    - get_aws_news (RSS)                        │  │
│             │     │  │    - execute_code (Code Interpreter)           │  │
│             │     │  └────────────────────────────────────────────────┘  │
│             │     │                        │                             │
│             │     │  ┌─────────────────────┴──────────────────────────┐  │
│             │     │  │               Built-in Tools                   │  │
│             │     │  │  ┌───────────────┐ ┌───────────────┐ ┌───────┐ │  │
│             │     │  │  │Code Interpreter│ │Memory Gateway │ │Browser│ │  │
│             │     │  │  │ (Python実行)  │ │ - 短期: Events│ │ Tool  │ │  │
│             │     │  │  │               │ │ - 長期: 要約  │ │       │ │  │
│             │     │  │  └───────────────┘ └───────────────┘ └───────┘ │  │
│             │     │  └────────────────────────────────────────────────┘  │
└─────────────┘     └──────────────────────────────────────────────────────┘
```

## 学習ステップ

このリポジトリは段階的に学べるようタグ付けされています。

| ステップ | タグ | 学べること | 追加内容 |
|---------|------|-----------|----------|
| 1 | `v0.1-claude-streaming` | Runtime + Claude + ストリーミング | 基本構成、モデル呼び出し、履歴、streaming |
| 2 | `v0.2-tool-use` | Tool Use + 外部API連携 | Service Quotas API、ニュース取得 |
| 3 | `v0.3-code-interpreter` | Code Interpreter | execute_code ツール |
| 4 | `v0.4-memory-gateway` | Memory Gateway | 長期記憶 |
| 5 | `v0.5-browser-tool` | Browser Tool | Web閲覧 |

### 各ステップの確認方法

```bash
# 例: 基本構成を確認
git checkout v0.1-claude-streaming
cat README.md

# 最新版に戻る
git checkout main
```

### ステップ間の差分確認

```bash
# ステップ間の差分を確認
git diff v0.1-claude-streaming v0.2-tool-use

# 特定ファイルの変更を確認
git diff v0.2-tool-use v0.3-code-interpreter -- agentcore-runtime/main.py
```

## 機能

### コア機能
- **Claude Sonnet 4.5**: JP Inference Profile で東京/大阪リージョンにルーティング
- **Cognito 認証**: User Pool + Identity Pool による認証
- **AgentCore 直接呼び出し**: 低レイテンシ、ストリーミング対応

### Custom Tools (Tool Use)
- **get_aws_service_info**: Service Quotas API でアカウント固有のクォータ値を取得
- **get_aws_news**: AWS What's New RSS フィードから最新情報を取得
- **execute_code**: Code Interpreter でPythonコードを実行
- **browse_web**: Browser Tool でWebページのコンテンツを取得

### Built-in Tools
- **Code Interpreter**: 安全なサンドボックス環境でPythonを実行
- **Memory Gateway**: ユーザー別の会話履歴を永続化
- **Browser Tool**: 管理されたブラウザ環境でWebページにアクセス

## ディレクトリ構成

```
.
├── agentcore-runtime/    # AgentCore Runtime (Python/Docker)
│   ├── main.py           # メインロジック + ツール定義
│   ├── Dockerfile
│   └── requirements.txt
├── frontend/             # React アプリ (Vite + TypeScript)
│   └── src/
├── lib/                  # CDK Stack 定義
│   └── agentcore-cdk-steps-stack.ts
└── bin/                  # CDK App エントリポイント
```

## デプロイ

### 前提条件

- Node.js 18+
- Python 3.11+
- Docker
- AWS CLI (プロファイル設定済み)
- AWS CDK v2
- **AWS Bedrock Claude モデルへのアクセス申請完了**

#### Claude モデルアクセス申請

1. **AWS Console** → **Bedrock** → **Model access** にアクセス
2. **Anthropic** の **Claude Sonnet 4.5** にチェック
3. **Request model access** をクリック
4. 利用目的を記入して申請
5. 承認まで通常数分～数時間待機

### 初回セットアップ

```bash
# 0. リポジトリをクローン
git clone https://github.com/mamezou/agentcore-cdk-steps.git
cd agentcore-cdk-steps

# 1. 依存関係インストール
npm install
cd frontend && npm install && cd ..

# 2. CDK Bootstrap (初回のみ)
npx cdk bootstrap

# 3. CDK デプロイ
npx cdk deploy

# 4. デプロイ結果から環境変数を取得
# 出力例:
# AgentCoreCdkStepsStack.UserPoolId = ap-northeast-1_xxxxxxxxx
# AgentCoreCdkStepsStack.UserPoolClientId = xxxxxxxxxxxxxxxxxxxxxxxxxx
# AgentCoreCdkStepsStack.IdentityPoolId = ap-northeast-1:xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
# AgentCoreCdkStepsStack.S3BucketName = agentcore-steps-dev-xxxxxxxxxxxx
# AgentCoreCdkStepsStack.AgentRuntimeArn = arn:aws:bedrock-agentcore:ap-northeast-1:xxxxxxxxxxxx:runtime/your-runtime
# AgentCoreCdkStepsStack.WebsiteUrl = http://agentcore-steps-dev-xxxxxxxxxxxx.s3-website-ap-northeast-1.amazonaws.com

# 以降のコマンドで使用する変数を設定（出力値で置き換え）
export USER_POOL_ID="ap-northeast-1_xxxxxxxxx"
export USER_POOL_CLIENT_ID="xxxxxxxxxxxxxxxxxxxxxxxxxx"
export IDENTITY_POOL_ID="ap-northeast-1:xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
export S3_BUCKET_NAME="agentcore-steps-dev-xxxxxxxxxxxx"
export AGENT_RUNTIME_ARN="arn:aws:bedrock-agentcore:ap-northeast-1:xxxxxxxxxxxx:runtime/your-runtime"
export WEBSITE_URL="http://agentcore-steps-dev-xxxxxxxxxxxx.s3-website-ap-northeast-1.amazonaws.com"

# 5. フロントエンド環境変数設定
cd frontend
cat > .env.production << EOF
VITE_USER_POOL_ID=${USER_POOL_ID}
VITE_USER_POOL_CLIENT_ID=${USER_POOL_CLIENT_ID}
VITE_IDENTITY_POOL_ID=${IDENTITY_POOL_ID}
VITE_AGENT_RUNTIME_ARN=${AGENT_RUNTIME_ARN}
VITE_AWS_REGION=ap-northeast-1
EOF

# 6. フロントエンドビルド & S3 アップロード
npm install
npm run build
aws s3 sync dist/ s3://${S3_BUCKET_NAME}/
cd ..

# 7. テストユーザー作成
aws cognito-idp admin-create-user \
  --user-pool-id ${USER_POOL_ID} \
  --username test@example.com \
  --user-attributes Name=email,Value=test@example.com \
  --temporary-password TempPass123! \
  --message-action SUPPRESS

aws cognito-idp admin-set-user-password \
  --user-pool-id ${USER_POOL_ID} \
  --username test@example.com \
  --password TestPass123! \
  --permanent

# 8. アクセス確認
echo "セットアップ完了！"
echo "Website URL: ${WEBSITE_URL}"
echo "ログイン情報: test@example.com / TestPass123!"
```

### (オプション) スクリプトで環境変数を自動生成

jqがインストールされている場合、以下のコマンドで環境変数ファイルを自動生成できます：

```bash
cd frontend
aws cloudformation describe-stacks --stack-name AgentCoreCdkStepsStack \
  --query 'Stacks[0].Outputs' --output json | \
  jq -r '
    "VITE_USER_POOL_ID=" + (.[] | select(.OutputKey=="UserPoolId") | .OutputValue),
    "VITE_USER_POOL_CLIENT_ID=" + (.[] | select(.OutputKey=="UserPoolClientId") | .OutputValue),
    "VITE_IDENTITY_POOL_ID=" + (.[] | select(.OutputKey=="IdentityPoolId") | .OutputValue),
    "VITE_AGENT_RUNTIME_ARN=" + (.[] | select(.OutputKey=="AgentRuntimeArn") | .OutputValue),
    "VITE_AWS_REGION=ap-northeast-1"
  ' > .env.production
```

### 更新時の手順

```bash
# コード変更後の再デプロイ
npx cdk deploy

# フロントエンドのみ更新
cd frontend
npm run build
aws s3 sync dist/ s3://${S3_BUCKET_NAME}/
```

### 環境変数 (frontend/.env.production)

```bash
VITE_USER_POOL_ID=ap-northeast-1_xxxxxxxxx
VITE_USER_POOL_CLIENT_ID=xxxxxxxxxxxxxxxxxxxxxxxxxx
VITE_IDENTITY_POOL_ID=ap-northeast-1:xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
VITE_AGENT_RUNTIME_ARN=arn:aws:bedrock-agentcore:ap-northeast-1:xxxxxxxxxxxx:runtime/your-runtime
VITE_AWS_REGION=ap-northeast-1
```

| 変数名 | 説明 | CDK出力での名前 |
|--------|------|----------------|
| `VITE_USER_POOL_ID` | Cognito User PoolのID | `AgentCoreCdkStepsStack.UserPoolId` |
| `VITE_USER_POOL_CLIENT_ID` | User Pool ClientのID | `AgentCoreCdkStepsStack.UserPoolClientId` |
| `VITE_IDENTITY_POOL_ID` | Cognito Identity PoolのID | `AgentCoreCdkStepsStack.IdentityPoolId` |
| `VITE_AGENT_RUNTIME_ARN` | Agent Core RuntimeのARN | `AgentCoreCdkStepsStack.AgentRuntimeArn` |
| `VITE_AWS_REGION` | AWSリージョン | 固定値: `ap-northeast-1` |

## ライセンス

MIT
