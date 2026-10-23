$ErrorActionPreference = 'Stop'
$tests = @(
  'test_w1_llm_resilience',
  'test_w2_parallel_tools',
  'test_w3_plan',
  'test_w3_plan_integration',
  'test_w4_tools',
  'test_w5_semantic',
  'test_w6_routing',
  'test_w7_approval',
  'test_w8_compression_subagent',
  'test_w9_production',
  'test_w10_rag',
  'test_w11_context_tracker',
  'test_w12_browser_image',
  'test_w13_updater_fix',
  'test_w14_pptx',
  'test_w14_version_fix',
  'test_w14_workspace',
  'test_w15_safe_spawn',
  'test_w16_markdown_spec',
  'test_w16_render_check',
  'test_w17_inline_completion'
)

$tsx = Join-Path $PSScriptRoot '..\node_modules\.bin\tsx.cmd'
if (-not (Test-Path $tsx)) { throw 'Missing local tsx. Run npm install first.' }

$totalPass = 0
$totalFail = 0
foreach ($test in $tests) {
  $file = Join-Path $PSScriptRoot "$test.mjs"
  if (-not (Test-Path $file)) { throw "Missing test script: $file" }

  $output = & $tsx $file 2>&1
  $output | Write-Host
  if ($LASTEXITCODE -ne 0) { throw "$test failed with exit code $LASTEXITCODE" }

  $line = $output | Where-Object { $_.ToString() -match '\d+\s+(?:passed|PASS),\s*\d+\s+(?:failed|FAIL)' } | Select-Object -Last 1
  if ($line -and $line.ToString() -match '(\d+)\s+(?:passed|PASS),\s*(\d+)\s+(?:failed|FAIL)') {
    $totalPass += [int]$Matches[1]
    $totalFail += [int]$Matches[2]
  }
}

Write-Host ""
Write-Host "===== Total: $totalPass passed, $totalFail failed ====="
if ($totalFail -gt 0) { exit 1 }
