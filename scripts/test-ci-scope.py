import importlib.util,unittest
s=importlib.util.spec_from_file_location('scope','scripts/ci-scope.py');scope=importlib.util.module_from_spec(s);s.loader.exec_module(scope)
class ScopeTest(unittest.TestCase):
    def test_boundaries(self):
        self.assertTrue(scope.docs_only(['README.md','docs/operations.md']))
        for paths in [[],['src/index.ts'],['.github/workflows/ci.yml'],['skills/run/SKILL.md'],['AGENTS.md'],['docs/a.json'],['README.md','package.json']]:
            self.assertFalse(scope.docs_only(paths))
    def test_original_plans(self): scope.verify_plans()
if __name__=='__main__': unittest.main()
