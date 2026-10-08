// Test-runtime network policy: fixtures may use DO bindings and local ingress,
// but no worker is allowed to make an unmocked outbound HTTP request.
import { createFetchMock } from 'miniflare';
export function denyOutbound(){const mock=createFetchMock();mock.disableNetConnect();return mock;}
