# onedrive-vercel-index

Forked by `spencerwooo/onedrive-vercel-index` and maintained by Codex.

add daily token refresh

## OneDrive 授权诊断（Upstash / Redis）

部署后自动记录真正发生的续期、刷新失败、凭据删除和重新授权保存事件，不需要增加环境变量。
普通访问命中已有 Token、或访问一个已经缺少刷新令牌的链接，不会新增诊断读写。
每天的 Cron 会单独记录一次“未找到刷新令牌”，不会覆盖最初的失败原因。

- 成功与失败历史分开保存，各保留最近 **180 天**，每类最多 **10,000 条**。
  写入时清理超期和超量记录；每类历史在最后一次写入 180 天后自动过期。
- 最新状态不设置过期时间，包括最后成功、最后失败、最后删除凭据原因、最后发现缺少刷新令牌的时间。
  后续重新授权、恢复成功或历史清理都不会覆盖最后失败和删除原因。
- 只记录事件类型、UTC 时间、来源、失败阶段、允许的 OAuth/网络错误码及微软数字错误码。
  不记录 Token、密钥、请求头、原始错误描述或个人资料。
- 诊断写入失败只输出不含凭据的警告，不改变续期结果。Redis 本身不可用时，无法把错误持久写入同一个 Redis。
- 每个事件通过一次 Lua 调用写入，脚本通常执行五个 Redis 操作，超过数量上限时为六个。
  这部分是新增诊断开销，不包含项目原有的 Token 读写；不需要轮询。
  Upstash 还会把外层 `EVAL` 计入命令数，单区域保守按 **6～7 条命令/事件**估算，不能把一次调用当成一条计费命令。
  例如按 30 天、每小时续期一次加每天一次 Cron，750 次成功事件至多约增加 5,250 条命令（故障事件另计）。
  计数依据：[Upstash Lua 命令计数说明](https://upstash.com/docs/redis/sdks/ratelimit-ts/costs)。

### 在 Upstash REPL 查看

下面命令假设没有设置 `KV_PREFIX`；如果设置了，所有键名都要原样加上该前缀。

查看关键状态（即使半年后才发现故障，也能先检查这里）：

```redis
HGETALL auth:diagnostics:state
```

也可以只查看最近一次实际失败和最后一次清除凭据的原因：

```redis
HGET auth:diagnostics:state last_failure
HGET auth:diagnostics:state last_token_clear
```

查看最近 20 条失败或成功事件（最新在前，`20` 只是读取数量，不是保存上限）：

```redis
ZREVRANGE auth:diagnostics:failures 0 19
ZREVRANGE auth:diagnostics:successes 0 19
```

`source` 为 `cron`（定时刷新）、`request`（访问触发）或 `authorization`（重新授权）。
`phase` 为 `token_read`、`token_refresh`、`token_write` 或 `token_clear`，可区分 Redis 问题与微软拒绝授权。
`refresh_failed` 后出现 `tokens_cleared` 且 `providerError` 为 `invalid_grant`，说明微软拒绝旧刷新令牌后程序清除了凭据。
只有 `refresh_token_missing` 则只证明当时没读到令牌，不能据此推断其丢失原因。

历史从本次部署后开始积累，无法还原部署前已经消失的错误。不要删除整个 Redis 数据库，否则诊断记录也会一同丢失。

### 验证

运行 `pnpm test:auth`、`pnpm exec tsc --noEmit`，并构建项目。
上线后完成一次授权或调用已有的、带 `CRON_SECRET` 验证的 `/api/refresh-auth/` 接口，
再运行 `HGETALL auth:diagnostics:state`，应看到 `last_success`。单纯浏览首页命中缓存不会生成成功记录。
