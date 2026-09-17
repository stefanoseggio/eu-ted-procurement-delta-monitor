// Calls the EU TED Procurement Delta Monitor Actor via the Apify API and prints each
// delivered record. Install first: npm install apify-client
// Run with: APIFY_TOKEN=your_token node examples/call-actor.cjs

const { ApifyClient } = require('apify-client');

const client = new ApifyClient({
    token: process.env.APIFY_TOKEN,
});

const input = {
    operationMode: 'INCREMENTAL',
    expertQuery: 'classification-cpv = 72* AND organisation-country-buyer = DEU AND publication-date >= today(-30)',
    onlyNew: true,
    maxItems: 100,
};

(async () => {
    // Zxy0w0zjmUoMzacF9 is the EU TED Procurement Delta Monitor Actor ID.
    const run = await client.actor('Zxy0w0zjmUoMzacF9').call(input);

    const { items } = await client.dataset(run.defaultDatasetId).listItems();

    for (const item of items) {
        console.log(`${item.event_type}: ${item.notice_title} — ${item.buyer_name} (${item.buyer_country})`);
    }

    console.log(`\nFetched ${items.length} records. Full run: https://console.apify.com/actors/runs/${run.id}`);
})();
