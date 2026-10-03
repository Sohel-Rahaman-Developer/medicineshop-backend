import assert from 'node:assert/strict';
import { test } from 'node:test';
import { numberInWords, rupeesInWords } from '../../src/utils/words';

void test('amount in words: Indian grouping (lakh, crore) and paise', () => {
  assert.equal(rupeesInWords(79_900), 'Rupees Seven Hundred Ninety-Nine Only');
  assert.equal(rupeesInWords(799_000), 'Rupees Seven Thousand Nine Hundred Ninety Only');
  assert.equal(rupeesInWords(12_050), 'Rupees One Hundred Twenty and Fifty Paise Only');
  assert.equal(numberInWords(1_00_000), 'One Lakh');
  assert.equal(numberInWords(12_34_56_789), 'Twelve Crore Thirty-Four Lakh Fifty-Six Thousand Seven Hundred Eighty-Nine');
  assert.equal(numberInWords(1_000_001), 'Ten Lakh One');
  assert.equal(rupeesInWords(1), 'Rupees Zero and One Paise Only');
  assert.equal(rupeesInWords(0), 'Rupees Zero Only');
});
