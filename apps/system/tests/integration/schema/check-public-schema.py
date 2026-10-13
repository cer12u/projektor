# @module verification
# @role public-schema
"""Validate OpenAPI 3.1 schema objects against JSON Schema 2020-12 and resolve local refs.
No network references are followed; this is schema and structural validation, not a claim of full OpenAPI conformance tooling.
"""
import json
from pathlib import Path
from jsonschema import Draft202012Validator
p=Path('docs/openapi.json')
spec=json.loads(p.read_text())
assert spec['openapi']=='3.1.0'
count=0

def walk(v):
    global count
    if isinstance(v,dict):
        if '$ref' in v:
            assert v['$ref'].startswith('#/'),v['$ref']
            target=spec
            for part in v['$ref'][2:].split('/'):
                target=target[part.replace('~1','/').replace('~0','~')]
        for key,value in v.items():
            if key=='schema':
                Draft202012Validator.check_schema(value)
                count+=1
            walk(value)
    elif isinstance(v,list):
        for item in v:walk(item)
for schema in spec['components']['schemas'].values():
    Draft202012Validator.check_schema(schema)
    count+=1
walk(spec)
print(json.dumps({'passed':True,'dialect':'JSON Schema 2020-12','checkedSchemas':count,'allLocalReferencesResolved':True}))
