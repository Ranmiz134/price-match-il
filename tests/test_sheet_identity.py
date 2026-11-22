import unittest
from core.loader import merge_base_catalog
from core.matcher import match_catalog_to_competitors
from scrapers.google_sheet import GoogleSheetSync


def product(sku, name='DJI Osmo Action 6 Adventure Combo', **extra):
    item = dict(id='sheet:'+sku, sku=sku, name=name, brand='DJI',
                barcodes=[], our_price=1000, source_id='dji_israel',
                source_name='DJI', source_url='https://example.com/product',
                secondary_sources=[])
    item.update(extra)
    return item


def offer(linked_sku):
    return dict(our_sku=linked_sku, title='DJI Osmo Action 6 Adventure Combo',
                price=900, url='https://example.com/offer', store_id='test',
                store_name='Test', in_stock=True, importer_status='official',
                barcodes=[])


class SheetIdentityTests(unittest.TestCase):
    def test_different_skus_with_same_signature_remain_separate(self):
        rows=[product('SKU-RED'), product('SKU-WHITE')]
        merged=merge_base_catalog(rows, [])
        self.assertEqual([x['sku'] for x in merged], ['SKU-RED','SKU-WHITE'])

    def test_different_nonempty_skus_do_not_merge_by_barcode(self):
        rows=[product('SKU-1',barcodes=['1234567890123']),
              product('SKU-2',barcodes=['1234567890123'])]
        self.assertEqual(len(merge_base_catalog(rows, [])),2)

    def test_same_sku_from_two_sources_still_merges(self):
        rows=merge_base_catalog([product('SAME')],
                               [product('SAME',source_id='benda_store')])
        self.assertEqual(len(rows),1)
        self.assertEqual(len(rows[0]['secondary_sources']),1)

    def test_unkeyed_legacy_record_can_still_merge(self):
        rows=merge_base_catalog([product('KEY')],
                               [product('',source_id='benda_store')])
        self.assertEqual(len(rows),1)
        self.assertEqual(rows[0]['sku'],'KEY')

    def test_empty_brand_stays_empty(self):
        rows=GoogleSheetSync.parse_our_catalog_rows([
            {'sku':'X','product_name':'Generic cable','our_price_vat':'250',
             'brand':'','our_url':'https://example.com/product'}])
        self.assertEqual(rows[0]['brand'],'')

    def test_explicit_different_sku_blocks_fuzzy_match(self):
        out=match_catalog_to_competitors([product('RIGHT')],[offer('OTHER')])
        self.assertEqual(out[0]['competitors'],[])

    def test_explicit_sku_match_ignores_case_and_whitespace(self):
        out=match_catalog_to_competitors([product(' right ')],[offer('RIGHT')])
        self.assertEqual(len(out[0]['competitors']),1)
        self.assertEqual(out[0]['competitors'][0]['match_type'],'sku_exact')

    def test_legacy_unlinked_offer_can_still_use_variant_match(self):
        out=match_catalog_to_competitors([product('RIGHT')],[offer('')])
        self.assertEqual(len(out[0]['competitors']),1)
        self.assertEqual(out[0]['competitors'][0]['match_type'],'variant_exact')

    def test_false_stock_and_unverified_importer_remain_distinct(self):
        parsed=GoogleSheetSync.parse_competitor_rows([
            {'our_sku':'RIGHT','price_vat':'900','product_url':'https://example.com/offer',
             'in_stock':'FALSE','importer_status':'unverified','store_name':'ALM'}])
        self.assertFalse(parsed[0]['in_stock'])
        self.assertEqual(parsed[0]['importer_status'],'unverified')
        self.assertEqual(parsed[0]['store_id'],'alm')


if __name__ == '__main__':
    unittest.main()
