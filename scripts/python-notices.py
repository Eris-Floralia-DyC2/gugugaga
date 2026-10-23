"""Retain installed distribution license files in the portable worker."""
import importlib.metadata as md
from pathlib import Path
import shutil
import sys
target=Path('runtime/ws-worker/licenses/python')
target.mkdir(parents=True,exist_ok=True)
lines=['# Python runtime dependency notices','', 'Original distribution metadata and available license files are retained below.','']
for dist in sorted(md.distributions(),key=lambda d:d.metadata.get('Name','')):
    name=dist.metadata.get('Name','unknown');version=dist.version
    if name.lower().replace('_','-') in {'tokenizers', 'numpy', 'filelock', 'protobuf', 'av', 'onnxruntime', 'ctranslate2', 'fsspec', 'flatbuffers', 'hf-xet', 'tqdm', 'huggingface-hub', 'faster-whisper', 'silk-python'}:continue
    lines.extend([f'## {name} {version}','',f'License: {dist.metadata.get("License-Expression") or dist.metadata.get("License") or "See package METADATA and upstream"}',''])
    folder=target/(name+'-'+version);folder.mkdir(exist_ok=True)
    (folder/'METADATA').write_text(dist.read_text('METADATA') or '',encoding='utf-8')
    for file in dist.files or []:
        if '__pycache__' in Path(str(file)).parts or Path(str(file)).suffix in ('.pyc','.pyo'):
            continue
        if any(part.lower().startswith(('license','copying','notice')) for part in Path(str(file)).parts):
            src=Path(dist.locate_file(file))
            if src.is_file():
                out=folder/Path(str(file));out.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(src,out)
# Python is a bundled runtime too, not an installed PyPI distribution.
python_license = next((Path(sys.base_prefix)/name for name in
                       ('LICENSE_PYTHON.txt', 'LICENSE.txt', 'LICENSE')
                       if (Path(sys.base_prefix)/name).is_file()), None)
if python_license is None:
    raise RuntimeError('Python interpreter license not found; verify the interpreter distribution')
shutil.copyfile(python_license, target.parent/'Python.LICENSE.txt')
(target.parent/'PYTHON-NOTICES.md').write_text('\n'.join(lines),encoding='utf-8')
