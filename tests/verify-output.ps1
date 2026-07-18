$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

$requiredFiles = @(
  'index.txt',
  'index.html',
  'api/upload-to-github.js',
  'functions/api/upload-to-github.js',
  '.env.example',
  'docs/change-report.md',
  'docs/deployment-guide.md',
  'docs/account-permission-audit-report.md',
  'docs/supabase-permissions.sql'
)

foreach ($file in $requiredFiles) {
  $path = Join-Path $root $file
  if (-not (Test-Path -LiteralPath $path)) {
    throw "Missing required file: $file"
  }
}

$textFiles = Get-ChildItem -LiteralPath $root -Recurse -File |
  Where-Object { $_.FullName -notmatch '\\.git\\' -and $_.Extension -in @('.txt', '.html', '.js', '.md', '.example', '.json') }

$combined = ($textFiles | ForEach-Object { Get-Content -LiteralPath $_.FullName -Raw }) -join "`n"
if ($combined -match 'ghp_[A-Za-z0-9_]+') {
  throw 'A GitHub personal access token appears to be committed in the files.'
}

$indexPath = Join-Path $root 'index.txt'
$htmlPath = Join-Path $root 'index.html'
$index = Get-Content -LiteralPath $indexPath -Raw
$txtHash = (Get-FileHash -LiteralPath $indexPath -Algorithm SHA256).Hash
$htmlHash = (Get-FileHash -LiteralPath $htmlPath -Algorithm SHA256).Hash
if ($txtHash -ne $htmlHash) {
  throw 'index.html must match index.txt because Cloudflare deploys the HTML file.'
}

if ($index -match "storage\.from\('couple-media'\)\.upload") {
  throw 'index.txt still uploads new media to Supabase Storage.'
}
if ($index -notmatch "/api/upload-to-github") {
  throw 'index.txt does not call /api/upload-to-github for new media uploads.'
}
if ($index -notmatch 'loading="lazy"' -or $index -notmatch 'decoding="async"') {
  throw 'index.txt is missing lazy image loading optimizations.'
}
if ($index -notmatch 'preload="metadata"') {
  throw 'index.txt is missing video metadata preload optimization.'
}
if ($index -notmatch 'refreshCurrentSection') {
  throw 'index.txt is missing active-section refresh optimization.'
}
if ($index -notmatch 'onlineStatusTimer') {
  throw 'index.txt is missing the guarded online status timer.'
}
if ($index -notmatch 'GITHUB_DIRECT_UPLOAD_TEST_MODE' -or $index -notmatch 'uploadToGitHubFromBrowser') {
  throw 'index.txt is missing the temporary browser-side GitHub upload test mode.'
}
if ($index -notmatch 'GITHUB_DIRECT_UPLOAD_TEST_MODE = false') {
  throw 'index.txt should have browser-side direct upload test mode disabled for deployment.'
}
if ($index -notmatch 'requirePermission' -or $index -notmatch 'forceRefreshUserData') {
  throw 'index.txt is missing the refreshed permission enforcement helpers.'
}
if ($index -match "setTimeout\(async \(\) =>") {
  throw 'User cloud sync must not be delayed through setTimeout because cross-device registration can appear successful locally but fail remotely.'
}
if ($index -match "u==='admin' && p==='admin123'") {
  throw 'Login must not bypass cloud user data with a hardcoded admin password.'
}
if ($index -notmatch 'function normalizeUsers' -or $index -notmatch 'function buildUserRow') {
  throw 'index.txt is missing normalized cloud user serialization helpers.'
}
if ($index -notmatch '\.upsert\(row, \{ onConflict: ''username'' \}\)') {
  throw 'User sync requires username-based upsert in code.'
}
$permissionsSql = Get-Content -LiteralPath (Join-Path $root 'docs/supabase-permissions.sql') -Raw
if ($permissionsSql -notmatch 'users_username_key' -or $permissionsSql -notmatch 'unique \(username\)') {
  throw 'Supabase permissions SQL must add a unique username constraint for cross-device account sync.'
}
if ($index -notmatch 'users = \{ \.\.\.defaultUsers, \.\.\.cloudUsers \}') {
  throw 'Cloud user refresh must not merge stale arbitrary local users ahead of cloud data.'
}
if ($index -notmatch 'async function saveUsers[\s\S]*?throw syncError') {
  throw 'saveUsers must surface cloud sync failures instead of silently ignoring them.'
}
if ($index -notmatch 'async function registerNewUser[\s\S]*?permission: ''full''[\s\S]*?role: ''user''[\s\S]*?catch') {
  throw 'registerNewUser must create full user records and report save failures.'
}
if ($index -notmatch 'let lastUserSyncError = null' -or $index -notmatch 'let lastPermissionError = null') {
  throw 'User sync and permission failures must be tracked instead of silently falling back to localStorage.'
}
if ($index -notmatch 'forceRefreshUserData\(options = \{\}\)' -or $index -notmatch 'allowLocalFallback') {
  throw 'forceRefreshUserData must support strict cloud reads for login and permission checks.'
}
if ($index -notmatch 'async function login[\s\S]*?loadUserData\(\{ allowLocalFallback: false \}\)[\s\S]*?catch') {
  throw 'login must fail clearly when cloud user data cannot be read, rather than using stale local users.'
}
if ($index -notmatch 'async function autoLogin[\s\S]*?loadUserData\(\{ allowLocalFallback: false \}\)[\s\S]*?catch') {
  throw 'autoLogin must refresh cloud user data before restoring a session.'
}
if ($index -notmatch 'function updateAdminVisibility' -or $index -notmatch 'adminBtn\.style\.display = isAdmin \? ''block'' : ''none''') {
  throw 'Admin button visibility must be explicitly refreshed for both admin and non-admin users.'
}
if ($index -notmatch 'async function requireAdmin' -or $index -notmatch 'forceRefreshUserData\(\{ allowLocalFallback: false \}\)') {
  throw 'Admin actions must re-check cloud role data before opening or changing admin settings.'
}
foreach ($fn in @('showRegisterModal', 'openAdminPanel', 'deleteUserAccount', 'toggleUserRole', 'setUserPermission', 'resetUserPwd')) {
  $pattern = "async function $fn[\s\S]*?requireAdmin\(\)"
  if ($index -notmatch $pattern) { throw "$fn must require an up-to-date admin role." }
}
if ($index -notmatch 'async function resetUserPwd[\s\S]*?try[\s\S]*?saveUsers\(users\)[\s\S]*?catch') {
  throw 'resetUserPwd must report cloud save failures instead of appearing successful locally.'
}
if ($index -notmatch 'async function hasPermission[\s\S]*?forceRefreshUserData\(\{ allowLocalFallback: false \}\)[\s\S]*?isAdmin =') {
  throw 'Permission checks must refresh cloud role/permission data before trusting cached isAdmin.'
}
if ($index -notmatch 'async function canDeleteRecord[\s\S]*?hasPermission\(''full''\)') {
  throw 'Deleting records must require full permission for non-admin users.'
}
if ($index -notmatch 'async function ensureCommentMutationAllowed[\s\S]*?hasPermission\(''comment''\)') {
  throw 'Deleting comments must require at least comment permission for non-admin users.'
}
if ($index -notmatch 'async function openBubbleSettings[\s\S]*?requirePermission\(''full''\)') {
  throw 'Opening shared bubble settings must require full permission.'
}
foreach ($fn in @('addLove', 'addMemory', 'addMemo', 'addSchedule', 'addCountdown', 'addMarker', 'toggleAngryMode', 'saveBubbleSettings', 'addPhotosToBubble')) {
  $pattern = "async function $fn[\s\S]*?requirePermission\('full'\)"
  if ($index -notmatch $pattern) { throw "$fn is missing full-permission enforcement." }
}
foreach ($fn in @('addFeedComment', 'addMsgComment', 'toggleFeedLike', 'toggleMessageLike', 'submitApology')) {
  $pattern = "async function $fn[\s\S]*?requirePermission\('comment'\)"
  if ($index -notmatch $pattern) { throw "$fn is missing comment-permission enforcement." }
}
foreach ($fn in @('deleteFeed', 'deleteMsg', 'deleteLove', 'deleteMemory', 'deleteMemo', 'deleteSchedule', 'deleteCountdown', 'deleteMarker')) {
  $pattern = "async function $fn[\s\S]*?canDeleteRecord"
  if ($index -notmatch $pattern) { throw "$fn is missing owner/admin delete enforcement." }
}

$api = Get-Content -LiteralPath (Join-Path $root 'api/upload-to-github.js') -Raw
if ($api -notmatch 'process\.env\.GITHUB_TOKEN') {
  throw 'Upload API must read GitHub token from process.env.GITHUB_TOKEN.'
}
$cloudflareApi = Get-Content -LiteralPath (Join-Path $root 'functions/api/upload-to-github.js') -Raw
if ($cloudflareApi -notmatch 'env\.GITHUB_TOKEN' -or $cloudflareApi -notmatch 'export async function onRequest') {
  throw 'Cloudflare Pages Function upload endpoint is missing env-based token handling.'
}
if ($cloudflareApi -notmatch 'request\.formData\(\)' -or $cloudflareApi -notmatch 'cdn\.jsdelivr\.net') {
  throw 'Cloudflare Pages Function should accept formData and return a jsDelivr URL.'
}
if ($api -notmatch 'cdn\.jsdelivr\.net') {
  throw 'Upload API should return a jsDelivr CDN URL for newly uploaded media.'
}
if ($api -notmatch 'repos/\$\{owner\}/\$\{repo\}/contents') {
  throw 'Upload API should write files through the GitHub contents API.'
}

Write-Host 'Verification passed: GitHub media upload, account sync, permissions, and traffic optimizations are present.'
