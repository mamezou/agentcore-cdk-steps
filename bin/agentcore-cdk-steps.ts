#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { AgentCoreCdkStepsStack } from '../lib/agentcore-cdk-steps-stack';

const app = new cdk.App();
new AgentCoreCdkStepsStack(app, 'AgentCoreCdkStepsStack', {
  environment: 'dev',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION || 'ap-northeast-1'
  }
});
