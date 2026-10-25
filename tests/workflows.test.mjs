import assert from 'node:assert/strict'
import { after, before, beforeEach, afterEach, test } from 'node:test'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { createServer } from 'vite'

let server, browser, context, page, baseURL, directory

before(async () => {
  server = await createServer({ cacheDir: 'node_modules/.vite-tests', server: { host: '127.0.0.1', port: 0, strictPort: false } })
  await server.listen()
  baseURL = server.resolvedUrls.local[0]
  browser = await chromium.launch()
})

after(async () => {
  await browser?.close()
  await server?.close()
})

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'webpeezy-test-'))
  context = await browser.newContext()
  page = await context.newPage()
  page.setDefaultTimeout(5000)
})

afterEach(async () => {
  await context?.close()
  await rm(directory, { recursive: true, force: true })
})

const image = (name, width, height, color = 'red') => ({
  name,
  mimeType: 'image/svg+xml',
  buffer: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="${color}"/></svg>`),
})

const upload = async (...images) => {
  await page.locator('input[type=file]').setInputFiles(images)
  await page.waitForFunction(() => {
    const rows = document.querySelectorAll('.queue-item')
    return rows.length > 0 && [...rows].every((row) => row.matches('.done, .error'))
  })
}

const convertedOutput = (index = 0) => page.locator('.queue-item-preview img').nth(index).evaluate(async (img) => {
  const blob = await (await fetch(img.src)).blob()
  const bitmap = await createImageBitmap(blob)
  const result = { width: bitmap.width, height: bitmap.height, type: blob.type, bytes: [...new Uint8Array(await blob.arrayBuffer())] }
  bitmap.close()
  return result
})

const deferred = () => {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

// Exercise the real Tauri JS clients while substituting IPC with isolated file IO.
// Native dialogs, permissions and platform filesystem behavior need a desktop run.
const nativeExport = async ({ initialDirectory = directory, pick = async () => directory, write = writeFile, openFolder = async () => {} } = {}) => {
  await page.exposeFunction('nativeInvoke', async (command, args, options) => {
    if (command === 'plugin:dialog|open') return pick()
    if (command === 'plugin:path|join') return join(...args.paths)
    if (command === 'plugin:fs|exists') {
      try { await stat(args.path); return true } catch (error) {
        if (error.code === 'ENOENT') return false
        throw error
      }
    }
    if (command === 'plugin:fs|write_file') {
      return write(decodeURIComponent(options.headers.path), Buffer.from(args))
    }
    if (command === 'plugin:opener|open_path') return openFolder(args.path)
    throw new Error(`Unexpected native command: ${command}`)
  })
  await page.addInitScript((initial) => {
    if (initial) localStorage.setItem('webp-output-directory', initial)
    window.__TAURI_INTERNALS__ = {
      invoke: (command, args, options) => window.nativeInvoke(
        command, command === 'plugin:fs|write_file' ? Array.from(args) : args, options
      ),
    }
  }, initialDirectory)
  await page.goto(baseURL)
}

test('copying the original-size preset preserves unlimited dimensions after save and reload', async () => {
  await page.goto(baseURL)
  await page.getByRole('button', { name: 'New preset', exact: true }).click()
  assert.equal(await page.getByLabel('Max width', { exact: true }).inputValue(), '')
  assert.equal(await page.getByLabel('Max height', { exact: true }).inputValue(), '')
  await page.getByLabel('Preset name').fill('Original copy')
  await page.getByRole('button', { name: 'Save preset', exact: true }).click()
  await page.reload()
  await page.getByRole('button', { name: /^Original copy/ }).click()
  await upload(image('large.svg', 2400, 1600))
  const output = await convertedOutput()
  assert.deepEqual([output.width, output.height, output.type], [2400, 1600, 'image/webp'])
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('webp-presets')).find((preset) => preset.name === 'Original copy'))
  assert.deepEqual([saved.maxWidth, saved.maxHeight], [null, null])
})

test('copying a width-only preset retains the unlimited height', async () => {
  await page.goto(baseURL)
  await page.getByLabel('Max width', { exact: true }).fill('600')
  await page.getByRole('button', { name: 'Save changes' }).click()
  await page.getByRole('button', { name: 'New preset', exact: true }).click()
  assert.equal(await page.getByLabel('Max width', { exact: true }).inputValue(), '600')
  assert.equal(await page.getByLabel('Max height', { exact: true }).inputValue(), '')
})

test('thumbnail conversion keeps thin images at least one pixel and preserves normal sizing', async () => {
  await page.goto(baseURL)
  await page.getByRole('button', { name: /^Thumbnail/ }).click()
  await upload(image('tall.svg', 1, 2000), image('wide.svg', 2000, 1), image('control.svg', 800, 600))
  assert.equal(await page.locator('.queue-item.done').count(), 3)
  for (const [index, dimensions] of [[0, [1, 400]], [1, [400, 1]], [2, [400, 300]]]) {
    const output = await convertedOutput(index)
    assert.deepEqual([output.width, output.height, output.type], [...dimensions, 'image/webp'])
  }
})

test('an SVG that cannot be exported fails without stalling the next image', async () => {
  await page.goto(baseURL)
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await upload({
    name: 'embedded-html.svg',
    mimeType: 'image/svg+xml',
    buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="60"><foreignObject width="100" height="60"><div xmlns="http://www.w3.org/1999/xhtml">Hello</div></foreignObject></svg>'),
  }, image('control.svg', 100, 60))
  assert.equal(await page.locator('.queue-item.error').count(), 1)
  assert.equal(await page.locator('.queue-item.done').count(), 1)
  assert.match(await page.locator('.queue-item.error').innerText(), /PNG or JPG/)
  assert.deepEqual(errors, [])
  assert.equal(await page.getByRole('button', { name: 'Clear queue' }).isEnabled(), true)
  const output = await convertedOutput(1)
  assert.deepEqual([output.width, output.height, output.type], [100, 60, 'image/webp'])
  const downloadEvent = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Download', exact: true }).click()
  const download = await downloadEvent
  assert.equal(download.suggestedFilename(), 'control.webp')
  assert.deepEqual(await readFile(await download.path()), Buffer.from(output.bytes))
})

test('a desktop webview without WebP canvas support uses binary native encoding and can retry', async () => {
  await nativeExport()
  await page.evaluate(() => {
    const toBlob = HTMLCanvasElement.prototype.toBlob
    HTMLCanvasElement.prototype.toBlob = function (callback) { toBlob.call(this, callback, 'image/png') }
    const invoke = window.__TAURI_INTERNALS__.invoke
    window.encodingCalls = []
    window.__TAURI_INTERNALS__.invoke = async (command, args, options) => {
      if (command !== 'encode_webp') return invoke(command, args, options)
      const headers = options.headers
      window.encodingCalls.push({ headers, binary: args instanceof Uint8Array, length: args.length })
      if (window.encodingCalls.length === 1) return Promise.reject('Native encoder temporarily unavailable')
      // Substitute only the encoder; real desktop coverage exercises libwebp.
      const canvas = document.createElement('canvas')
      canvas.width = Number(headers['x-image-width'])
      canvas.height = Number(headers['x-image-height'])
      canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(args), canvas.width, canvas.height), 0, 0)
      const blob = await new Promise((resolve) => toBlob.call(canvas, resolve, 'image/webp', Number(headers['x-image-quality']) / 100))
      return blob.arrayBuffer()
    }
  })
  await page.getByLabel('Max width', { exact: true }).fill('50')
  await page.getByLabel('Quality', { exact: true }).press('End')
  await page.getByRole('button', { name: 'Save changes' }).click()
  await upload(image('photo.svg', 100, 60))
  assert.equal(await page.locator('.queue-item.error').count(), 1)
  assert.match(await page.locator('.queue-item.error').innerText(), /Native encoder temporarily unavailable/)
  await page.getByRole('button', { name: 'Retry', exact: true }).click()
  await page.locator('.queue-item.done').waitFor()
  const output = await convertedOutput()
  assert.deepEqual([output.width, output.height, output.type], [50, 30, 'image/webp'])
  const calls = await page.evaluate(() => window.encodingCalls)
  assert.equal(calls.length, 2)
  for (const call of calls) assert.deepEqual(call, {
    headers: { 'x-image-width': '50', 'x-image-height': '30', 'x-image-quality': '100' },
    binary: true, length: 50 * 30 * 4,
  })
  await page.getByRole('button', { name: 'Save 1 ready image', exact: true }).click()
  await page.locator('.queue-status').filter({ hasText: 'Saved' }).waitFor()
  const saved = await readFile(join(directory, 'photo.webp'))
  assert.equal(saved.toString('ascii', 0, 4), 'RIFF')
  assert.equal(saved.toString('ascii', 8, 12), 'WEBP')
  assert.deepEqual(saved, Buffer.from(output.bytes))
})

test('a browser without WebP canvas support reports failure instead of exporting a disguised PNG', async () => {
  await page.goto(baseURL)
  await page.evaluate(() => {
    const toBlob = HTMLCanvasElement.prototype.toBlob
    HTMLCanvasElement.prototype.toBlob = function (callback) { toBlob.call(this, callback, 'image/png') }
  })
  await upload(image('photo.svg', 100, 60))
  assert.equal(await page.locator('.queue-item.done').count(), 0)
  assert.equal(await page.locator('.queue-item.error').count(), 1)
  assert.match(await page.locator('.queue-item.error').innerText(), /This browser cannot create WebP files/)
})

test('queue buttons support Enter and Space without opening the image picker', async () => {
  await page.goto(baseURL)
  await upload(image('photo.svg', 100, 60), image('other.svg', 50, 30))
  await page.evaluate(() => {
    window.pickerClicks = 0
    document.querySelector('input[type=file]').click = () => { window.pickerClicks += 1 }
  })
  await page.getByRole('button', { name: 'Remove photo.svg from the queue' }).press('Enter')
  assert.equal(await page.locator('.queue-item').count(), 1)
  const expected = Buffer.from((await convertedOutput()).bytes)
  const downloadEvent = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Download', exact: true }).press('Space')
  const download = await downloadEvent
  assert.equal(download.suggestedFilename(), 'other.webp')
  assert.deepEqual(await readFile(await download.path()), expected)
  await page.getByRole('button', { name: 'Remove other.svg from the queue' }).press('Space')
  await page.locator('.queue-item').waitFor({ state: 'detached' })
  assert.equal(await page.locator('.queue-item').count(), 0)
  assert.equal(await page.evaluate(() => window.pickerClicks), 0)
  await page.getByRole('button', { name: 'Add images to convert', exact: true }).press('Enter')
  assert.equal(await page.evaluate(() => window.pickerClicks), 1)
  await page.getByRole('button', { name: 'Choose images', exact: true }).press('Space')
  assert.equal(await page.evaluate(() => window.pickerClicks), 2)
})

test('pending saves lock conflicting actions and preserve distinct files with the same name', async (t) => {
  const gate = deferred()
  const started = deferred()
  t.after(() => gate.resolve())
  let writes = 0
  await nativeExport({ write: async (path, data) => {
    writes += 1
    started.resolve()
    await gate.promise
    await writeFile(path, data)
  } })
  const control = Buffer.from('existing file must remain unchanged')
  await writeFile(join(directory, 'photo.webp'), control)
  await upload(image('photo.svg', 100, 60, 'red'), image('photo.svg', 100, 60, 'blue'))
  const expected = [(await convertedOutput(0)).bytes, (await convertedOutput(1)).bytes].map((bytes) => Buffer.from(bytes))
  await page.getByRole('button', { name: 'Save', exact: true }).nth(0).click()
  await started.promise
  for (const button of [
    page.getByRole('button', { name: 'Save', exact: true }).nth(1),
    page.getByRole('button', { name: 'Change folder' }),
    page.getByRole('button', { name: 'Clear', exact: true }),
    page.getByRole('button', { name: 'Clear queue', exact: true }),
    page.getByRole('button', { name: 'Remove photo.svg from the queue' }).nth(0),
  ]) assert.equal(await button.isDisabled(), true)
  assert.equal(writes, 1)
  gate.resolve()
  await page.locator('.queue-status').filter({ hasText: 'Saved' }).waitFor()
  await page.getByRole('button', { name: 'Save 1 ready image', exact: true }).click()
  await page.waitForFunction(() => [...document.querySelectorAll('.queue-status')].every((status) => status.textContent === 'Saved'))
  assert.deepEqual((await readdir(directory)).sort(), ['photo-2.webp', 'photo-3.webp', 'photo.webp'])
  assert.deepEqual(await readFile(join(directory, 'photo.webp')), control)
  assert.deepEqual(await readFile(join(directory, 'photo-2.webp')), expected[0])
  assert.deepEqual(await readFile(join(directory, 'photo-3.webp')), expected[1])
})

test('browser batch downloads retain their files until every download has started', async () => {
  await page.goto(baseURL)
  await upload(image('first.svg', 100, 60), image('second.svg', 50, 30), image('third.svg', 30, 20))
  const expected = await Promise.all([0, 1, 2].map(async (index) => Buffer.from((await convertedOutput(index)).bytes)))
  await page.evaluate(() => {
    const original = window.setTimeout
    window.downloadTimers = []
    window.setTimeout = (handler, delay, ...args) => {
      if (typeof handler === 'function' && (delay === 120 || delay === 240)) {
        window.downloadTimers.push(() => handler(...args))
        return -window.downloadTimers.length
      }
      return original(handler, delay, ...args)
    }
  })
  const downloads = []
  const finished = deferred()
  page.on('download', (download) => {
    downloads.push(download)
    if (downloads.length === 3) finished.resolve()
  })
  const first = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Download 3 ready images' }).click()
  await first
  assert.equal(await page.getByRole('button', { name: 'Clear queue' }).isDisabled(), true)
  assert.equal(await page.getByRole('button', { name: 'Remove second.svg from the queue' }).isDisabled(), true)
  assert.equal(await page.locator('.notice.success').count(), 0)
  for (let index = 0; index < 2; index += 1) {
    await page.waitForFunction(() => window.downloadTimers.length > 0)
    await page.evaluate(() => window.downloadTimers.shift()())
  }
  await finished.promise
  await page.getByRole('button', { name: 'Clear queue' }).click()
  for (const [index, download] of downloads.entries()) {
    assert.equal(await download.failure(), null)
    assert.equal(download.suggestedFilename(), ['first.webp', 'second.webp', 'third.webp'][index])
    assert.deepEqual(await readFile(await download.path()), expected[index])
  }
})

test('saving stays locked through folder selection, and cancel allows another attempt', async (t) => {
  const picker = deferred()
  const started = deferred()
  t.after(() => picker.resolve(null))
  let picks = 0
  await nativeExport({ initialDirectory: null, pick: async () => {
    picks += 1
    started.resolve()
    return picks === 1 ? picker.promise : directory
  } })
  await upload(image('photo.svg', 100, 60))
  await page.getByRole('button', { name: 'Choose folder & save 1' }).click()
  await started.promise
  assert.equal(await page.getByRole('button', { name: 'Save', exact: true }).isDisabled(), true)
  assert.equal(await page.getByRole('button', { name: 'Choose folder', exact: true }).isDisabled(), true)
  assert.equal(await page.getByRole('button', { name: 'Clear queue' }).isDisabled(), true)
  picker.resolve(null)
  await page.getByRole('button', { name: 'Choose folder & save 1' }).click()
  await page.locator('.queue-status').filter({ hasText: 'Saved' }).waitFor()
  assert.equal(picks, 2)
  assert.deepEqual((await readdir(directory)), ['photo.webp'])
})

test('retry after a partial save writes only the failed image', async () => {
  let rejectOnce = true
  await nativeExport({ write: async (path, data) => {
    if (path.endsWith('second.webp') && rejectOnce) {
      rejectOnce = false
      throw new Error('Temporary write failure')
    }
    await writeFile(path, data)
  } })
  await upload(image('first.svg', 100, 60), image('second.svg', 50, 30))
  const expected = [(await convertedOutput(0)).bytes, (await convertedOutput(1)).bytes].map((bytes) => Buffer.from(bytes))
  await page.getByRole('button', { name: 'Save 2 ready images', exact: true }).click()
  await page.getByText('Saved 1 image, but 1 still needs attention.', { exact: true }).waitFor()
  assert.deepEqual(await readdir(directory), ['first.webp'])
  await page.getByRole('button', { name: 'Save 1 ready image', exact: true }).click()
  await page.waitForFunction(() => [...document.querySelectorAll('.queue-status')].every((status) => status.textContent === 'Saved'))
  assert.deepEqual((await readdir(directory)).sort(), ['first.webp', 'second.webp'])
  assert.deepEqual(await readFile(join(directory, 'first.webp')), expected[0])
  assert.deepEqual(await readFile(join(directory, 'second.webp')), expected[1])
})

test('reselecting the same export folder preserves saved items; a different folder allows export', async () => {
  const otherDirectory = join(directory, 'other')
  await mkdir(otherDirectory)
  let chosenDirectory = directory
  await nativeExport({ pick: async () => chosenDirectory })
  await upload(image('photo.svg', 100, 60))
  const expected = Buffer.from((await convertedOutput()).bytes)
  await page.getByRole('button', { name: 'Save 1 ready image', exact: true }).click()
  await page.locator('.queue-status').filter({ hasText: 'Saved' }).waitFor()
  await page.getByRole('button', { name: 'Change folder' }).click()
  await page.getByText(/^New exports will save to/).waitFor()
  assert.equal(await page.locator('.queue-status').innerText(), 'Saved')
  assert.equal(await page.getByRole('button', { name: 'Save 0 ready images', exact: true }).isDisabled(), true)
  assert.deepEqual((await readdir(directory)).sort(), ['other', 'photo.webp'])
  chosenDirectory = otherDirectory
  await page.getByRole('button', { name: 'Change folder' }).click()
  await page.locator('.queue-status').filter({ hasText: 'Ready' }).waitFor()
  await page.getByRole('button', { name: 'Save 1 ready image', exact: true }).click()
  await page.locator('.queue-status').filter({ hasText: 'Saved' }).waitFor()
  assert.deepEqual(await readdir(otherDirectory), ['photo.webp'])
  assert.deepEqual(await readFile(join(directory, 'photo.webp')), expected)
  assert.deepEqual(await readFile(join(otherDirectory, 'photo.webp')), expected)
})

test('a failure to open the folder preserves partial-save warnings and successful files', async () => {
  let failSecond = true
  await nativeExport({
    write: async (path, data) => {
      if (failSecond && path.endsWith('second.webp')) throw new Error('Temporary write failure')
      await writeFile(path, data)
    },
    openFolder: async () => { throw new Error('Folder opener unavailable') },
  })
  await upload(image('first.svg', 100, 60), image('second.svg', 50, 30))
  const expected = await Promise.all([0, 1].map(async (index) => Buffer.from((await convertedOutput(index)).bytes)))
  await page.getByRole('button', { name: 'Save 2 ready images', exact: true }).click()
  await page.waitForFunction(() => {
    const button = [...document.querySelectorAll('button')].find((entry) => entry.textContent === 'Save 1 ready image')
    return button && !button.disabled
  })
  assert.match(await page.locator('.notice-copy').innerText(), /1 still needs attention/)
  assert.match(await page.locator('.notice-copy').innerText(), /folder could not be opened/i)
  assert.deepEqual(await readdir(directory), ['first.webp'])
  assert.deepEqual(await readFile(join(directory, 'first.webp')), expected[0])
  failSecond = false
  await page.getByRole('button', { name: 'Save 1 ready image', exact: true }).click()
  await page.waitForFunction(() => [...document.querySelectorAll('.queue-status')].every((status) => status.textContent === 'Saved'))
  assert.deepEqual((await readdir(directory)).sort(), ['first.webp', 'second.webp'])
  assert.deepEqual(await readFile(join(directory, 'first.webp')), expected[0])
  assert.deepEqual(await readFile(join(directory, 'second.webp')), expected[1])
})
