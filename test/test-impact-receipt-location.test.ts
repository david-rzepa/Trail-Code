import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { userInfo } from 'node:os';
import { test } from 'node:test';
import { defaultStateRoot } from '../src/test-impact/receipts.js';

test('default receipt location is rejected before creation when home is a checkout',()=>{
  const home=realpathSync(userInfo().homedir);
  assert.throws(()=>defaultStateRoot(home),/inside the checkout/);
});
