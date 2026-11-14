#!/usr/bin/env python3
"""Fail closed for executable/configuration or unproved changes."""
import hashlib,json,re,subprocess,sys
from pathlib import Path

def docs_only(paths):
    return bool(paths) and all(p=='README.md' or p.startswith('docs/') and p.endswith('.md') for p in paths)

def verify_plans():
    rows=json.loads(Path('docs/plans/provenance.json').read_text())
    if len(rows)!=5: raise ValueError('plan inventory changed')
    for row in rows:
        if Path(row['file']).name!=row['file']: raise ValueError('invalid plan path')
        if hashlib.sha256(Path('docs/plans',row['file']).read_bytes()).hexdigest()!=row['sha256']:
            raise ValueError('original plan changed')

if __name__=='__main__':
    verify_plans()
    if len(sys.argv)!=3 or not all(re.fullmatch('[0-9a-f]{40}',x) for x in sys.argv[1:]):
        raise SystemExit('expected immutable base/head revisions')
    paths=subprocess.check_output(['git','diff','--name-only','-z',sys.argv[1],sys.argv[2]],text=True).split('\0')
    print('docs_only='+str(docs_only([p for p in paths if p])).lower())
