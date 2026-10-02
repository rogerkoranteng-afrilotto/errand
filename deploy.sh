#!/usr/bin/env bash
# Reproducible deploy with the plain aws CLI. No SAM, no CDK.
# Usage: ./deploy.sh backend | frontend | all
# Needs: aws CLI authenticated to account 854924711083, node 22+, and ../../.env (PayPal sandbox credentials).
# State (gitignored) lives in .deploy-state/: agent-key.b64 (RSA key the agent signs cart tokens with), vault-token-id
# (the budget holder's vaulted PayPal wallet), api-url, cf-id, cf-info, webhook-id.
set -euo pipefail
cd "$(dirname "$0")"
REGION=us-east-1; ACCOUNT=854924711083
FN=errand-api; TABLE=errand; ROLE=errand-lambda; BUCKET=errand-site-$ACCOUNT
STATE=.deploy-state; mkdir -p $STATE
set -a; . ../../.env; set +a
export AWS_DEFAULT_REGION=$REGION AWS_PAGER=""
[ -f $STATE/agent-key.b64 ] || openssl genrsa 2048 2>/dev/null | base64 -w0 > $STATE/agent-key.b64
[ -f $STATE/vault-token-id ] || { [ -f $STATE/vault-token-id-shared ] && cp $STATE/vault-token-id-shared $STATE/vault-token-id; }
[ -f $STATE/vault-token-id ] || { echo "no vault token: run node scripts/vault.mjs, approve, then node scripts/vault.mjs --finish <id>"; exit 1; }

envjson() {
  API_URL=$(cat $STATE/api-url 2>/dev/null || true); SITE=""
  [ -f $STATE/cf-info ] && SITE="https://$(awk '{print $2}' $STATE/cf-info)"
  API_URL="$API_URL" SITE="$SITE" WEBHOOK_ID="$(cat $STATE/webhook-id 2>/dev/null || true)" VAULT="$(cat $STATE/vault-token-id)" AGENT_KEY="$(cat $STATE/agent-key.b64)" \
  node -e 'const e=process.env;console.log(JSON.stringify({Variables:{PAYPAL_CLIENT_ID:e.PAYPAL_CLIENT_ID,PAYPAL_SECRET:e.PAYPAL_SECRET,PAYPAL_API:e.PAYPAL_API,TABLE:"errand",BEDROCK_MODEL:e.BEDROCK_MODEL,VAULT_TOKEN_ID:e.VAULT,AGENT_JWT_KEY:e.AGENT_KEY,API_URL:e.API_URL,SITE:e.SITE,WEBHOOK_ID:e.WEBHOOK_ID,FUND_NAME:"Relief fund"}}))'
}

backend() {
  echo "== DynamoDB"
  aws dynamodb describe-table --table-name $TABLE >/dev/null 2>&1 || {
    aws dynamodb create-table --table-name $TABLE --attribute-definitions AttributeName=pk,AttributeType=S \
      --key-schema AttributeName=pk,KeyType=HASH --billing-mode PAY_PER_REQUEST >/dev/null
    aws dynamodb wait table-exists --table-name $TABLE
    aws dynamodb update-time-to-live --table-name $TABLE --time-to-live-specification Enabled=true,AttributeName=ttl >/dev/null; }
  echo "== IAM role"
  aws iam get-role --role-name $ROLE >/dev/null 2>&1 || {
    aws iam create-role --role-name $ROLE --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}' >/dev/null
    sleep 10; }
  aws iam put-role-policy --role-name $ROLE --policy-name errand --policy-document "{\"Version\":\"2012-10-17\",\"Statement\":[
   {\"Effect\":\"Allow\",\"Action\":[\"dynamodb:GetItem\",\"dynamodb:PutItem\",\"dynamodb:DeleteItem\",\"dynamodb:Scan\"],\"Resource\":\"arn:aws:dynamodb:$REGION:$ACCOUNT:table/$TABLE\"},
   {\"Effect\":\"Allow\",\"Action\":[\"bedrock:InvokeModel\",\"bedrock:Converse\",\"bedrock:InvokeModelWithResponseStream\"],\"Resource\":\"*\"},
   {\"Effect\":\"Allow\",\"Action\":[\"lambda:InvokeFunction\"],\"Resource\":\"arn:aws:lambda:$REGION:$ACCOUNT:function:$FN\"},
   {\"Effect\":\"Allow\",\"Action\":[\"logs:CreateLogGroup\",\"logs:CreateLogStream\",\"logs:PutLogEvents\"],\"Resource\":\"*\"}]}"
  echo "== package (the Node 22 runtime already provides the AWS SDK v3 clients)"
  rm -f $STATE/fn.zip; (cd backend && zip -q -j ../$STATE/fn.zip *.mjs package.json)
  if aws lambda get-function --function-name $FN >/dev/null 2>&1; then
    aws lambda update-function-code --function-name $FN --zip-file fileb://$STATE/fn.zip >/dev/null
    aws lambda wait function-updated --function-name $FN
  else
    aws lambda create-function --function-name $FN --runtime nodejs22.x --handler index.handler --role arn:aws:iam::$ACCOUNT:role/$ROLE \
      --zip-file fileb://$STATE/fn.zip --timeout 600 --memory-size 1024 --environment "$(envjson)" >/dev/null
    aws lambda wait function-active --function-name $FN
  fi
  echo "== Function URL"
  if ! aws lambda get-function-url-config --function-name $FN >/dev/null 2>&1; then
    aws lambda create-function-url-config --function-name $FN --auth-type NONE \
      --cors '{"AllowOrigins":["*"],"AllowMethods":["GET","POST","PUT"],"AllowHeaders":["content-type","authorization"],"MaxAge":3600}' >/dev/null
    aws lambda add-permission --function-name $FN --statement-id url-public --action lambda:InvokeFunctionUrl --principal '*' --function-url-auth-type NONE >/dev/null
    aws lambda add-permission --function-name $FN --statement-id url-invoke --action lambda:InvokeFunction --principal "*" >/dev/null  # since Oct 2025 the URL also needs this grant; CLI 2.27 lacks --invoked-via-function-url
  fi
  aws lambda get-function-url-config --function-name $FN --query FunctionUrl --output text | tee $STATE/api-url
  # A failed async invocation must not retry: a retried run would search and buy again.
  aws lambda put-function-event-invoke-config --function-name $FN --maximum-retry-attempts 0 >/dev/null
  echo "== webhook (reuses an existing registration for this URL)"
  node scripts/register-webhook.mjs "$(cat $STATE/api-url)"
  aws lambda update-function-configuration --function-name $FN --environment "$(envjson)" --timeout 600 --memory-size 1024 >/dev/null
  aws lambda wait function-updated --function-name $FN
}

frontend() {
  API=$(cat $STATE/api-url)
  echo "== build"
  (cd frontend && npm ci --silent && VITE_API="${API%/}" npm run build)
  echo "== S3 + CloudFront"
  aws s3api head-bucket --bucket $BUCKET 2>/dev/null || aws s3api create-bucket --bucket $BUCKET >/dev/null
  aws s3api put-public-access-block --bucket $BUCKET --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
  if [ ! -f $STATE/cf-id ]; then
    OAC=$(aws cloudfront create-origin-access-control --origin-access-control-config "Name=errand-oac,SigningProtocol=sigv4,SigningBehavior=always,OriginAccessControlOriginType=s3" --query OriginAccessControl.Id --output text)
    cat > $STATE/cf.json <<JSON
{"CallerReference":"errand-$(date +%s)","Comment":"errand","Enabled":true,"DefaultRootObject":"index.html","PriceClass":"PriceClass_100",
 "Origins":{"Quantity":1,"Items":[{"Id":"s3","DomainName":"$BUCKET.s3.$REGION.amazonaws.com","OriginAccessControlId":"$OAC","S3OriginConfig":{"OriginAccessIdentity":""}}]},
 "DefaultCacheBehavior":{"TargetOriginId":"s3","ViewerProtocolPolicy":"redirect-to-https","Compress":true,"CachePolicyId":"658327ea-f89d-4fab-a63d-7e88639e58f6",
  "AllowedMethods":{"Quantity":2,"Items":["GET","HEAD"]}},
 "CustomErrorResponses":{"Quantity":1,"Items":[{"ErrorCode":403,"ResponsePagePath":"/index.html","ResponseCode":"200","ErrorCachingMinTTL":10}]}}
JSON
    aws cloudfront create-distribution --distribution-config file://$STATE/cf.json --query 'Distribution.[Id,DomainName]' --output text > $STATE/cf-info
    awk '{print $1}' $STATE/cf-info > $STATE/cf-id
  fi
  CF=$(cat $STATE/cf-id)
  aws s3api put-bucket-policy --bucket $BUCKET --policy "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Principal\":{\"Service\":\"cloudfront.amazonaws.com\"},\"Action\":\"s3:GetObject\",\"Resource\":\"arn:aws:s3:::$BUCKET/*\",\"Condition\":{\"StringEquals\":{\"AWS:SourceArn\":\"arn:aws:cloudfront::$ACCOUNT:distribution/$CF\"}}}]}"
  aws s3 sync frontend/dist s3://$BUCKET --delete --cache-control "public,max-age=300" --only-show-errors
  aws s3 cp frontend/dist/index.html s3://$BUCKET/index.html --cache-control "no-cache" --only-show-errors
  aws cloudfront create-invalidation --distribution-id $CF --paths '/*' >/dev/null
  echo "CloudFront: https://$(awk '{print $2}' $STATE/cf-info)"
}

siteenv() { # SITE is only known after CloudFront exists, so push the environment once more
  aws lambda update-function-configuration --function-name $FN --environment "$(envjson)" >/dev/null
  aws lambda wait function-updated --function-name $FN
}

case "${1:-all}" in
  backend) backend;;
  frontend) frontend; siteenv;;
  all) backend; frontend; siteenv;;
esac
