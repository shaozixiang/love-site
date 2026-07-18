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

$index = Get-Content -LiteralPath (Join-Path $root 'index.txt') -Raw
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
foreach ($fn in @('addLove', 'addMemory', 'addMemo', 'addSchedule', 'addCountdown', 'addMarker', 'toggleAngryMode')) {
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

Write-Host 'Verification passed: GitHub media upload and traffic optimizations are present.'
