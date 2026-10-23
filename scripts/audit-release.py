"""Compatibility entry point: read-only public-file scan; never opens user message databases."""
from pathlib import Path
import runpy
runpy.run_path(str(Path(__file__).with_name('audit-public.py')), run_name='__main__')
