# Calls the EU TED Procurement Delta Monitor Actor via the Apify API and prints each
# delivered record. Install first: pip install apify-client
# Run with: APIFY_TOKEN=your_token python examples/call_actor.py

import os

from apify_client import ApifyClient

client = ApifyClient(os.environ["APIFY_TOKEN"])

run_input = {
    "operationMode": "INCREMENTAL",
    "expertQuery": "classification-cpv = 72* AND organisation-country-buyer = DEU AND publication-date >= today(-30)",
    "onlyNew": True,
    "maxItems": 100,
}

# Zxy0w0zjmUoMzacF9 is the EU TED Procurement Delta Monitor Actor ID.
run = client.actor("Zxy0w0zjmUoMzacF9").call(run_input=run_input)

items = list(client.dataset(run["defaultDatasetId"]).iterate_items())

for item in items:
    print(f"{item['event_type']}: {item['notice_title']} — {item['buyer_name']} ({item['buyer_country']})")

print(f"\nFetched {len(items)} records. Full run: https://console.apify.com/actors/runs/{run['id']}")
