import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ecr_assets from 'aws-cdk-lib/aws-ecr-assets';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as agentcore from '@aws-cdk/aws-bedrock-agentcore-alpha';
import * as path from 'path';

export interface AgentCoreCdkStepsStackProps extends cdk.StackProps {
  environment: 'dev' | 'prod';
}

export class AgentCoreCdkStepsStack extends cdk.Stack {
  public readonly websiteUrl: string;

  constructor(scope: Construct, id: string, props: AgentCoreCdkStepsStackProps) {
    super(scope, id, props);

    // Agent Core Runtime をDockerイメージからデプロイ
    // ARM64プラットフォームを指定してコスト効率を向上
    const agentRuntime = new agentcore.Runtime(this, 'ChatAgentRuntime', {
      runtimeName: 'aws_update_checker_steps',
      agentRuntimeArtifact: agentcore.AgentRuntimeArtifact.fromAsset(
        path.join(__dirname, '..', 'agentcore-runtime'),
        {
          platform: ecr_assets.Platform.LINUX_ARM64
        }
      ),
      networkConfiguration: agentcore.RuntimeNetworkConfiguration.usingPublicNetwork()
    });

    const agentRuntimeArn = agentRuntime.agentRuntimeArn;

    // Bedrock Claude モデルへのアクセス権限を付与
    agentRuntime.role.addToPrincipalPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'bedrock:InvokeModel',
        'bedrock:InvokeModelWithResponseStream'
      ],
      resources: [
        'arn:aws:bedrock:ap-northeast-1:*:inference-profile/jp.anthropic.claude-sonnet-4-5-20250929-v1:0',
        'arn:aws:bedrock:ap-northeast-1:*:inference-profile/jp.anthropic.claude-haiku-4-5-20251001-v1:0',
        'arn:aws:bedrock:ap-northeast-1::foundation-model/anthropic.claude-sonnet-4-5-20250929-v1:0',
        'arn:aws:bedrock:ap-northeast-1::foundation-model/anthropic.claude-haiku-4-5-20251001-v1:0',
        'arn:aws:bedrock:ap-northeast-3::foundation-model/anthropic.claude-sonnet-4-5-20250929-v1:0',
        'arn:aws:bedrock:ap-northeast-3::foundation-model/anthropic.claude-haiku-4-5-20251001-v1:0'
      ]
    }));

    // Service Quotas API へのアクセス権限
    agentRuntime.role.addToPrincipalPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'servicequotas:GetServiceQuota',
        'servicequotas:ListServiceQuotas'
      ],
      resources: ['*']
    }));

    // Code Interpreter へのアクセス権限
    agentRuntime.role.addToPrincipalPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'bedrock-agentcore:StartCodeInterpreterSession',
        'bedrock-agentcore:InvokeCodeInterpreter',
        'bedrock-agentcore:StopCodeInterpreterSession'
      ],
      resources: ['*']
    }));

    // Cognito User Pool
    const userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: `agentcore-steps-${props.environment}`,
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      autoVerify: { email: true },
      passwordPolicy: {
        minLength: 8,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: false
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: cdk.RemovalPolicy.DESTROY
    });

    const userPoolClient = new cognito.UserPoolClient(this, 'UserPoolClient', {
      userPool,
      userPoolClientName: `agentcore-steps-client-${props.environment}`,
      authFlows: {
        userPassword: true,
        userSrp: true
      },
      generateSecret: false
    });

    // Cognito Identity Pool（AgentCore直接呼び出し用）
    const identityPool = new cognito.CfnIdentityPool(this, 'IdentityPool', {
      identityPoolName: `agentcore_steps_${props.environment}`,
      allowUnauthenticatedIdentities: false,
      cognitoIdentityProviders: [{
        clientId: userPoolClient.userPoolClientId,
        providerName: userPool.userPoolProviderName
      }]
    });

    // 認証済みユーザー用 IAM ロール
    const authenticatedRole = new iam.Role(this, 'CognitoAuthenticatedRole', {
      assumedBy: new iam.FederatedPrincipal(
        'cognito-identity.amazonaws.com',
        {
          StringEquals: {
            'cognito-identity.amazonaws.com:aud': identityPool.ref
          },
          'ForAnyValue:StringLike': {
            'cognito-identity.amazonaws.com:amr': 'authenticated'
          }
        },
        'sts:AssumeRoleWithWebIdentity'
      )
    });

    // AgentCore 直接呼び出し権限
    authenticatedRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'bedrock-agentcore:InvokeAgentRuntime',
        'bedrock-agentcore:InvokeAgentRuntimeWithResponseStream'
      ],
      resources: [
        agentRuntimeArn,
        `${agentRuntimeArn}/runtime-endpoint/*`
      ]
    }));

    new cognito.CfnIdentityPoolRoleAttachment(this, 'IdentityPoolRoleAttachment', {
      identityPoolId: identityPool.ref,
      roles: {
        authenticated: authenticatedRole.roleArn
      }
    });

    // S3 静的ウェブサイトホスティング
    const websiteBucket = new s3.Bucket(this, 'WebsiteBucket', {
      bucketName: `agentcore-steps-${props.environment}-${this.account}`,
      websiteIndexDocument: 'index.html',
      websiteErrorDocument: 'index.html',
      publicReadAccess: true,
      blockPublicAccess: new s3.BlockPublicAccess({
        blockPublicAcls: false,
        blockPublicPolicy: false,
        ignorePublicAcls: false,
        restrictPublicBuckets: false
      }),
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true
    });

    this.websiteUrl = websiteBucket.bucketWebsiteUrl;

    // Outputs
    new cdk.CfnOutput(this, 'WebsiteUrl', {
      value: this.websiteUrl,
      description: 'S3 Website URL'
    });

    new cdk.CfnOutput(this, 'AgentRuntimeArn', {
      value: agentRuntimeArn,
      description: 'Agent Core Runtime ARN'
    });

    new cdk.CfnOutput(this, 'UserPoolId', {
      value: userPool.userPoolId,
      description: 'Cognito User Pool ID'
    });

    new cdk.CfnOutput(this, 'UserPoolClientId', {
      value: userPoolClient.userPoolClientId,
      description: 'Cognito User Pool Client ID'
    });

    new cdk.CfnOutput(this, 'IdentityPoolId', {
      value: identityPool.ref,
      description: 'Cognito Identity Pool ID'
    });

    new cdk.CfnOutput(this, 'S3BucketName', {
      value: websiteBucket.bucketName,
      description: 'S3 Bucket Name for frontend deployment'
    });
  }
}
