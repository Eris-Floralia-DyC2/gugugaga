$ErrorActionPreference='Stop'
$projectRoot=Split-Path $PSScriptRoot -Parent
Set-Location -LiteralPath $projectRoot
$python=$env:WS_BUILD_PYTHON
if (!$python) { $python=Join-Path $projectRoot '.venv\Scripts\python.exe' }
if (!(Test-Path -LiteralPath $python)) { throw '按 requirements-lock.txt 准备构建虚拟环境，或设置 WS_BUILD_PYTHON' }
$private=$env:WS_PRIVATE_ROOT
if (!$private) { $private=Join-Path $projectRoot 'WS-Private' }
if (![IO.Path]::IsPathRooted($private)) { throw 'WS_PRIVATE_ROOT must be absolute' }
$env:TEMP=Join-Path $private 'temp';$env:TMP=$env:TEMP;$env:PYTHONUTF8='1';$env:PYTHONDONTWRITEBYTECODE='1'
New-Item -ItemType Directory -Path $env:TEMP -Force | Out-Null
$env:HF_HOME=Join-Path $private 'cache\huggingface'
$env:HF_HUB_CACHE=Join-Path $env:HF_HOME 'hub'
$env:HF_XET_CACHE=Join-Path $env:HF_HOME 'xet'
$env:XET_LOG_DIR=Join-Path $private 'logs\xet'
$env:XDG_CACHE_HOME=Join-Path $private 'cache\libraries'
$env:TORCH_HOME=Join-Path $private 'cache\torch'
$env:HF_HUB_OFFLINE='1';$env:HF_HUB_DISABLE_TELEMETRY='1'
foreach($dir in @($env:HF_HOME,$env:HF_HUB_CACHE,$env:HF_XET_CACHE,$env:XET_LOG_DIR,$env:XDG_CACHE_HOME,$env:TORCH_HOME)){New-Item -ItemType Directory -Path $dir -Force | Out-Null}
$build=Join-Path $private ('build\worker-040-'+[guid]::NewGuid())
if(Test-Path -LiteralPath (Join-Path $projectRoot 'runtime/ws-worker')){throw '请先归档旧 runtime，必须干净构建'}
& $python -m PyInstaller --noconfirm --onedir --name ws-worker --distpath runtime --workpath $build --specpath $build --paths integration --paths integration/vendor --collect-all Crypto --collect-all zstandard --exclude-module audio --exclude-module faster_whisper --exclude-module ctranslate2 --exclude-module onnxruntime --exclude-module numpy --exclude-module av --exclude-module pysilk --exclude-module tokenizers --exclude-module huggingface_hub --exclude-module hf_xet --exclude-module torch integration/worker.py
if($LASTEXITCODE -ne 0){throw 'worker build failed'}
New-Item -ItemType Directory -Path runtime/ws-worker/licenses -Force | Out-Null
Copy-Item -LiteralPath integration/vendor/UPSTREAM-LICENSE.txt,integration/vendor/COMPAT-LICENSE.txt,integration/vendor/NOTICE.md -Destination runtime/ws-worker/licenses
& $python scripts/python-notices.py
if($LASTEXITCODE -ne 0){throw 'Python license collection failed'}
