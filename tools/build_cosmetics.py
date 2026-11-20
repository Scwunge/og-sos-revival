"""Build data/cosmetics.json from extracted StoreItemDefinitions + Season_01_Tiers (scratch dir). Derived facts only."""
import json, sys
sys.path.insert(0, __import__('os').path.dirname(__file__))
import dt_dump as t
src, tiers, out = sys.argv[1], sys.argv[2], sys.argv[3]
cat = {'Outfit':'outfit','Gesture':'gesture','Icon':'icon','License':'license','Reward':'reward','XPBoost':'xp_boost','SPBoost':'sp_boost','Coin':'coin','Pack':'pack','Pass':'pass'}
_, rows = t.dump(src); items = []
for rn, p in rows:
    nm = p['Name']['strings'][-1] if p['Name']['strings'] else rn
    ty = p['Type'].split('::')[1]
    e = {'id': rn, 'category': cat[ty], 'name': nm}
    if p.get('Amount'): e['amount'] = p['Amount']
    if p.get('Cost'): e['cost'] = p['Cost']
    if p.get('StoreItemIds'): e['contains'] = p['StoreItemIds']
    items.append(e)
ids = {i['id'] for i in items}
_, tr = t.dump(tiers)
ref = {x for _, p in tr for k in ('PremiumItemIds','FreeItemIds') for x in p.get(k, [])}
assert ref <= ids, ref - ids
json.dump({'source': 'SOS-WindowsClient.pak /Game/Blueprints/Storefront/StoreItemDefinitions (DataTable, row struct StoreItemDefinition); ids are DataTable row names',
 'keyField': 'row name of StoreItemDefinitions == StoreItemIds/ItemId (e.g. o_ninja_a_m)',
 'grantableCategories': ['outfit','gesture','icon','license'],
 'items': items}, open(out, 'w'), indent=1)
import collections; print(collections.Counter(i['category'] for i in items), len(items))
