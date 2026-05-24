# codex-openai-reauthorizer

一个用于 sub2api 的 OpenAI / Codex 账号重新授权工具。

它会自动扫描需要重新授权的账号，打开真实浏览器完成 OpenAI 登录流程，读取邮箱验证码，处理授权回调，并把新的 OAuth 凭据回写到 sub2api，同时保存本地 token 和操作日志。

## 功能

- 扫描需要重新授权的 sub2api OAuth 账号
- 支持按账号 ID、邮箱、分组、套餐筛选
- 支持交互式选择单个账号，或先按分组筛选后用 `all` 批量处理同一组账号
- 自动打开浏览器完成登录、验证码输入和授权确认
- 支持邮箱验证码从 Cloudflare 邮箱辅助页读取
- 遇到账号被删除/停用时自动跳过并记录
- 遇到免费账号要求绑定手机号时自动跳过
- 遇到 Plus 账号手机号验证时改用 ChatGPT session access token
- 更新 sub2api 账号凭据、清理错误状态，并写入本地 token 文件和日志

## 环境要求

- Node.js 18+
- Chrome 或 Edge
- 可访问的 sub2api 管理接口
- 可访问的邮箱服务辅助页

## 安装

```powershell
npm install
copy config.example.json config.json
notepad config.json
```

## 配置

编辑 `config.json`，至少填写这些项：

- `sub2apiBaseUrl`
- `sub2apiAdminEmail`
- `sub2apiAdminPassword`
- `mailBaseUrl`
- `mailAdminPassword`

可选项：

- `mailSitePassword`
- `mailDomain`
- `mailTimeoutMs`
- `oauthRedirectUri`
- `tokenOutputDirs`
- `tokenFilenameMode`
- `reauthLogFile`
- `browserWindowWidth`
- `browserWindowHeight`
- `chromePath`
- `edgePath`
- `candidateErrorKeywords`
- `preferredGroupNames`
- `preferredGroupIds`


## 运行方式

### 1. 扫描候选账号

```powershell
node index.js --list-candidates
```

### 2. 处理单个账号

按 ID：

```powershell
node index.js --account-id 123
```

按邮箱：

```powershell
node index.js --email user@example.com
```

### 3. 自动处理第一个匹配账号

```powershell
node index.js --auto
```

### 4. 交互式处理

先扫描，再手动确认：

```powershell
node index.js --interactive
```

在候选列表里可以输入：

- 序号
- 账号 ID
- 邮箱
- `all` 一次处理全部匹配账号

如果想按分组分批处理，可以直接先加分组筛选，再在该组候选里输入 `all`：

```powershell
node index.js --interactive --group plus
node index.js --interactive --group-id 1
```

### 5. 常用筛选

```powershell
node index.js --interactive --group plus
node index.js --interactive --plan free
node index.js --auto --group-id 1
node index.js --auto --prefer-group plus
node index.js --auto --prefer-group-id 1
```

参数说明：

- `--group` / `--group-id`：严格过滤候选账号
- `--prefer-group` / `--prefer-group-id`：优先处理匹配账号，但不排除其他候选
- `--plan`：按套餐过滤，支持 `free` / `plus`
- `--confirm`：和 `--interactive` 等价
- `--interactive` 配合 `--group` / `--group-id` 可按分组分批次选择账号

## 处理流程

1. 扫描 sub2api 中符合条件的 OAuth 账号
2. 打开浏览器进入 OpenAI 登录页
3. 输入邮箱并继续
4. 如遇密码页，点击“一次性验证码登录”
5. 从邮箱辅助页读取验证码并填入
6. 完成授权确认
7. 获取回调地址中的授权码并兑换凭据
8. 更新 sub2api 账号状态和凭据
9. 写入本地 token 文件和 reauth 日志

## 输出文件

- `tokens/`：本地 token 文件
- `data/reauth-log.json`：重新授权日志

## 注意事项

- 如果账号被删除/停用，工具会跳过该账号继续后续流程

## 友情链接
- linux.do