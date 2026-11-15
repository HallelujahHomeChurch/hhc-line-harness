import importlib.util
import json
import unittest
from unittest.mock import patch
from pathlib import Path

spec = importlib.util.spec_from_file_location('release', Path(__file__).with_name('closed-release.py'))
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)

IMAGE = 'alive.azurecr.io/hhc-line-harness@sha256:' + 'a' * 64
SECRETS = {k: 'https://alive-vault.vault.azure.net/secrets/hhc-line-harness-' + k + '/' + 'b' * 32
           for k in ['api-database-url', 'migrate-database-url', 'channel-secret']}
ROOT = '/subscriptions/3765a72c-2c30-492c-8b88-7a26522903f8/resourceGroups/hhc-line-harness/providers/Microsoft.App/'

class ReleaseTest(unittest.TestCase):
    def test_identity_resource_ids_ignore_casing_but_reject_other_identities(self):
        for stage in ['api', 'migrate']:
            expected = release.render(stage, IMAGE, SECRETS)['resources'][0]
            actual = json.loads(json.dumps(expected))
            identity = next(iter(expected['identity']['userAssignedIdentities']))
            actual['identity']['userAssignedIdentities'] = {identity.lower(): {'clientId': 'provider-metadata'}}
            release.verify(actual, expected)
            for identities in [{identity.lower() + '-other': {}}, {identity.lower(): {}, identity + '-other': {}}]:
                actual['identity']['userAssignedIdentities'] = identities
                with self.assertRaisesRegex(ValueError, 'identity mismatch'):
                    release.verify(actual, expected)

    def test_cli_preview_uses_json_and_rejects_writes_outside_target(self):
        for stage in ['api', 'migrate']:
            def fake_output(args):
                if args[1:3] == ['account', 'show']:
                    return json.dumps({'id': release.SUBSCRIPTION}).encode()
                if args[1] == 'containerapp' and 'list' in args:
                    return b'[]'
                if args[1:4] == ['deployment', 'group', 'what-if']:
                    if '--no-pretty-print' not in args:
                        return b'Resource changes: 1 to create, 1 to modify.'
                    return json.dumps({'status': 'Succeeded', 'changes': [
                        {'resourceId': release.resource_id(stage), 'changeType': 'Create'},
                        {'resourceId': ROOT+'containerApps/unrelated', 'changeType': 'Modify'},
                    ]}).encode()
                raise AssertionError('unexpected write: '+str(args))
            with patch.object(release.subprocess, 'check_output', fake_output):
                with self.assertRaisesRegex(ValueError, 'preview exceeds stage scope'):
                    release.deploy(stage, IMAGE, SECRETS)

    def test_admitted_active_or_draining_revision_fences_closed_latest_template(self):
        for active, replicas in [(True, 0), (False, 1)]:
            calls = []
            def fake_az(*args):
                calls.append(args)
                if args == ('account', 'show'): return {'id': release.SUBSCRIPTION}
                if args == ('containerapp', 'list', '-g', release.GROUP):
                    return [{'name':'hhc-line-harness-api','properties':{'template':{'containers':[{'env':[{'name':'HARNESS_ENABLED','value':'false'}]}]}}}]
                if args[:3] == ('containerapp','revision','list'):
                    rows = [{'properties':{'active':active,'replicas':replicas,'template':{'containers':[{'env':[{'name':'HARNESS_ENABLED','value':'true'}]}]}}}]
                    return rows if active or '--all' in args else []
                if args == ('containerapp', 'job', 'list', '-g', release.GROUP): return []
                raise AssertionError('unexpected write: '+str(args))
            with patch.object(release, 'az', fake_az):
                with self.assertRaisesRegex(ValueError, 'admitted'):
                    release.deploy('migrate', IMAGE, SECRETS)
            self.assertFalse(any('deployment' in c or 'start' in c for c in calls))

    def test_admitted_api_fences_migration_before_any_cloud_write(self):
        calls = []
        def fake_az(*args):
            calls.append(args)
            if args == ('account', 'show'): return {'id': release.SUBSCRIPTION}
            if args == ('containerapp', 'list', '-g', release.GROUP):
                return [{'name':'hhc-line-harness-api','properties':{'template':{'containers':[{'env':[{'name':'HARNESS_ENABLED','value':'true'}]}]}}}]
            if args == ('containerapp', 'job', 'list', '-g', release.GROUP): return []
            raise AssertionError('unexpected write or admission call: '+str(args))
        with patch.object(release, 'az', fake_az):
            with self.assertRaisesRegex(ValueError, 'admitted'):
                release.deploy('migrate', IMAGE, SECRETS)
        self.assertFalse(any('deployment' in c or 'start' in c for c in calls))

    def test_private_closed_api_and_separate_migration(self):
        api = release.render('api', IMAGE, SECRETS)['resources'][0]
        job = release.render('migrate', IMAGE, SECRETS)['resources'][0]
        self.assertEqual(api['name'], 'hhc-line-harness-api')
        self.assertEqual(job['name'], 'hhc-line-harness-migrate')
        self.assertFalse(api['properties']['configuration']['ingress']['external'])
        self.assertFalse(api['properties']['configuration']['ingress']['allowInsecure'])
        self.assertEqual(api['properties']['template']['scale'], {'minReplicas': 1, 'maxReplicas': 1})
        for resource in [api, job]:
            container = resource['properties']['template']['containers'][0]
            self.assertEqual(container['image'], IMAGE)
            self.assertEqual(container['resources'], {'cpu': 0.25, 'memory': '0.5Gi'})
            env = {x['name']: x for x in container['env']}
            self.assertEqual(env['HARNESS_ENABLED']['value'], 'false')
            self.assertEqual(env['AGENT_ENABLED']['value'], 'false')
            self.assertEqual(env['EMBEDDING_ENABLED']['value'], 'false')
        self.assertNotEqual(api['identity'], job['identity'])
        config = job['properties']['configuration']
        self.assertEqual(config['triggerType'], 'Manual')
        self.assertEqual(config['replicaRetryLimit'], 0)
        self.assertEqual(config['manualTriggerConfig'], {'parallelism': 1, 'replicaCompletionCount': 1})
        self.assertEqual(len(config['secrets']), 1)

    def test_rejects_wrong_image_or_secret_owner_and_unpinned_secret(self):
        for image in ['alive.azurecr.io/asset-api@sha256:' + 'a'*64, 'alive.azurecr.io/hhc-line-harness:latest']:
            with self.assertRaises(ValueError): release.render('api', image, SECRETS)
        for value in [SECRETS['migrate-database-url'], SECRETS['api-database-url'].rsplit('/', 1)[0], 'https://evil.invalid/secrets/x/'+'b'*32]:
            with self.assertRaises(ValueError):
                release.render('api', IMAGE, {**SECRETS, 'api-database-url': value})

    def test_preview_rejects_other_resources_deletion_and_incomplete_results(self):
        good = {'status': 'Succeeded', 'changes': [{'resourceId': ROOT+'containerApps/hhc-line-harness-api', 'changeType': 'Create'}]}
        release.check_preview(good, 'api')
        for preview in [{}, {'status': 'Failed', 'changes': good['changes']}, {'status': 'Succeeded', 'changes': []},
                        {'status':'Succeeded','changes':good['changes']*2}]:
            with self.assertRaises(ValueError): release.check_preview(preview, 'api')
        for kind in ['Delete', 'Deploy', 'Ignore', 'Unsupported']:
            with self.assertRaises(ValueError):
                release.check_preview({'status':'Succeeded','changes':[dict(good['changes'][0], changeType=kind)]}, 'api')
        with self.assertRaises(ValueError):
            release.check_preview({'status':'Succeeded','changes':good['changes']+[{'resourceId':ROOT+'containerApps/other','changeType':'Modify'}]}, 'api')

if __name__ == '__main__': unittest.main()
