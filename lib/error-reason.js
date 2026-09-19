// Persist only known categories, never upstream messages, headers or credentials.
export function errorReason(raw) {
  let error;
  try { error=JSON.parse(raw)?.error; } catch { return 'unknown'; }
  const codes=['insufficient_user_quota','pre_consume_token_quota_failed','access_denied','model_not_found','invalid_api_key','rate_limit_exceeded','subscription_quota','ip_denied','account_or_channel_disabled','model_or_group_denied'];
  if(codes.includes(error?.code))return error.code;
  const message=String(error?.message || '');
  if(/订阅额度不足|subscription quota insufficient|no active subscription/i.test(message))return 'subscription_quota';
  if(/用户额度不足|预扣费额度失败.*用户剩余额度|insufficient.*quota|insufficient.*balance/i.test(message))return 'insufficient_user_quota';
  if(/令牌.*额度|token.*quota/i.test(message))return 'pre_consume_token_quota_failed';
  if(/IP.*不在|IP.*允许|IP.*not.*allow/i.test(message))return 'ip_denied';
  if(/禁用|banned|disabled/i.test(message))return 'account_or_channel_disabled';
  if(/无权|分组|model.*access|permission/i.test(message))return 'model_or_group_denied';
  return 'unknown';
}
