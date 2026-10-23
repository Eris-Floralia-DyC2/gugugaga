import contextlib, importlib.util, io, json, os, tempfile, unittest, zipfile
from pathlib import Path
from types import SimpleNamespace

spec=importlib.util.spec_from_file_location('ws_public_audit',Path(__file__).resolve().parents[2]/'scripts/audit-public.py')
audit=importlib.util.module_from_spec(spec);spec.loader.exec_module(audit)

class PublicAuditTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(dir=os.environ['WS_TEST_TMP'])
        self.base=Path(self.tmp.name);self.public=self.base/'public';self.public.mkdir()
        self.old=os.environ.get('WS_PRIVATE_ROOT');os.environ['WS_PRIVATE_ROOT']=str(self.base/'private')
    def tearDown(self):
        if self.old is None:os.environ.pop('WS_PRIVATE_ROOT',None)
        else:os.environ['WS_PRIVATE_ROOT']=self.old
        self.tmp.cleanup()
    def scan(self):
        report=self.base/'private/report.json'
        with contextlib.redirect_stdout(io.StringIO()):
            code=audit.run(SimpleNamespace(targets=[str(self.public)],report=str(report),git_root=None,embedded_python=False))
        return code,json.loads(report.read_text(encoding='utf8')),report.read_text(encoding='utf8')
    def test_nested_archive_reports_secret_location_without_value(self):
        token='sk-'+'A'*24
        inner=io.BytesIO()
        with zipfile.ZipFile(inner,'w') as z:z.writestr('config.txt',token)
        with zipfile.ZipFile(self.public/'bundle.zip','w') as z:z.writestr('nested.zip',inner.getvalue());z.writestr('account.db',b'synthetic')
        code,report,text=self.scan()
        self.assertEqual(code,1);self.assertNotIn(token,text)
        self.assertTrue(any('nested.zip!config.txt' in f['file'] for f in report['findings']))
        self.assertTrue(any(f['kind']=='private-file-type' for f in report['findings']))
    def test_private_root_and_junction_are_never_followed(self):
        private=self.public/'WS-Private';private.mkdir();(private/'account.db').write_text('synthetic')
        outside=self.base/'outside';outside.mkdir();(outside/'secret.txt').write_text('sk-'+'B'*24)
        link=self.public/'linked';os.symlink(outside,link,target_is_directory=True) if os.name!='nt' else __import__('subprocess').run(['cmd','/c','mklink','/J',str(link),str(outside)],check=True,capture_output=True)
        try:
            code,report,text=self.scan();self.assertEqual(code,1)
            self.assertNotIn('secret.txt',text);self.assertNotIn('account.db',text)
            self.assertTrue(any(f['kind']=='reparse-point-not-followed' for f in report['findings']))
        finally:link.rmdir() if os.name=='nt' else link.unlink()
    def test_identical_files_reuse_scan_but_retain_both_locations(self):
        data='sk-'+'C'*24
        for name in ('a.txt','b.txt'):(self.public/name).write_text(data)
        _,report,_=self.scan()
        self.assertEqual(report['counts']['duplicate_files'],1)
        self.assertEqual({f['file'] for f in report['findings']},{'public/a.txt','public/b.txt'})

if __name__=='__main__':unittest.main()
