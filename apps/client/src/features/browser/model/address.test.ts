import assert from 'node:assert/strict'
import test from 'node:test'

import { formatBrowserAddressHost, resolveBrowserAddress } from './address.js'

test('resolveBrowserAddress preserves explicit URLs and blank pages', () => {
  assert.equal(resolveBrowserAddress('https://example.com/path', 'bing'), 'https://example.com/path')
  assert.equal(resolveBrowserAddress('about:blank', 'bing'), 'about:blank')
})

test('resolveBrowserAddress recognizes domains, localhost, and IP addresses', () => {
  assert.equal(resolveBrowserAddress('example.com/path', 'bing'), 'https://example.com/path')
  assert.equal(resolveBrowserAddress('localhost:5173', 'bing'), 'https://localhost:5173')
  assert.equal(resolveBrowserAddress('127.0.0.1:5173/test', 'bing'), 'https://127.0.0.1:5173/test')
})

test('resolveBrowserAddress uses the selected search engine for plain text', () => {
  assert.equal(resolveBrowserAddress('local LLM browser', 'bing'), 'https://www.bing.com/search?q=local%20LLM%20browser')
  assert.equal(resolveBrowserAddress('本地模型', 'baidu'), 'https://www.baidu.com/s?wd=%E6%9C%AC%E5%9C%B0%E6%A8%A1%E5%9E%8B')
  assert.equal(resolveBrowserAddress('agent sdk', 'google'), 'https://www.google.com/search?q=agent%20sdk')
})

test('formatBrowserAddressHost keeps only the HTTP host for compact display', () => {
  assert.equal(formatBrowserAddressHost('https://www.ifeed.cc/radar?range=72h'), 'www.ifeed.cc')
  assert.equal(formatBrowserAddressHost('http://localhost:5173/session/1'), 'localhost:5173')
  assert.equal(formatBrowserAddressHost('about:blank'), '')
  assert.equal(formatBrowserAddressHost('custom:value'), 'custom:value')
})
