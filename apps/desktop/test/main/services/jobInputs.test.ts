import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ControlAdapterEntry, EngineFeatures } from '@shared/types'
import { pickJobInputs, validateJobInputs, type JobInputContext } from '@main/services/jobInputs'
import { useTempDir } from '@test/helpers/tempDir'

const root = useTempDir('mossstudio-inputs-')
const outside = useTempDir('mossstudio-inputs-outside-')

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16])
const WEBP = Buffer.from('RIFF\0\0\0\0WEBPVP8 ')

const assets = (): string => join(root(), 'projects', 'p1', 'assets')
const outputs = (): string => join(root(), 'outputs')

function put(path: string, data: Buffer = PNG): string {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, data)
  return path
}

const features = (patch: Partial<EngineFeatures> = {}): EngineFeatures => ({
  preview: true, imageInput: true, control: true, references: true, hires: true, samplers: true,
  values: { sampler: ['euler', 'heun'], scheduler: ['karras'], resize: ['crop', 'fit', 'stretch'], step_cache: ['off', 'fbcache'] },
  ...patch,
})

function adapter(path: string, patch: Partial<ControlAdapterEntry> = {}): ControlAdapterEntry {
  return { id: 'control-1', name: 'union.safetensors', path, sizeBytes: 10, controlKinds: ['depth', 'canny'], addedAt: 'now', ...patch }
}

function context(patch: Partial<JobInputContext> = {}): JobInputContext {
  return { imageRoots: [assets(), outputs()], controlAdapters: [], features: features(), ...patch }
}

/** The error code and message a validation fails with. */
async function failure(source: Record<string, unknown>, ctx: JobInputContext = context()): Promise<{ code: string; message: string }> {
  try {
    await validateJobInputs(source, ctx)
  } catch (error) {
    return { code: String((error as { code?: string }).code), message: (error as Error).message }
  }
  throw new Error('validation passed')
}

describe('pickJobInputs', () => {
  it('keeps only the image-input fields that are set', () => {
    expect(pickJobInputs({ prompt: 'x', initImage: { path: '/a' }, mask: null, sampling: undefined, references: { paths: [] } }))
      .toEqual({ initImage: { path: '/a' }, references: { paths: [] } })
  })
})

describe('validateJobInputs: accepted requests', () => {
  it('returns nothing to add when no inputs are set', async () => {
    await expect(validateJobInputs({ prompt: 'a cat' }, context())).resolves.toEqual({})
  })

  it('accepts pictures from the project assets and the outputs, and every setting within limits', async () => {
    const init = put(join(assets(), 'init.png'))
    const mask = put(join(assets(), 'mask-c1-ab.png'))
    const depth = put(join(outputs(), 'depth.jpg'), JPEG)
    const ref = put(join(outputs(), 'nested', 'ref.png'))
    const file = put(join(root(), 'models', 'union.safetensors'), Buffer.from('x'))
    const result = await validateJobInputs({
      initImage: { path: init, strength: 0.6, resize: 'fit' },
      mask: { path: mask },
      control: { adapter: file, loraStrength: 1, images: [{ kind: 'depth', path: depth, strength: 10, start: 0, end: 1 }] },
      references: { paths: [ref, ref, ref, ref], maxEdge: 2048 },
      sampling: { sampler: 'heun', scheduler: 'karras', shift: 3, hires: { width: 1536, height: 1536, steps: 0, strength: 1 }, stepCache: 'fbcache', cfgTruncation: 0 },
    }, context({ controlAdapters: [adapter(file)] }))
    expect(result).toEqual({
      initImage: { path: init, strength: 0.6, resize: 'fit' },
      mask: { path: mask },
      control: { adapter: file, loraStrength: 1, images: [{ kind: 'depth', path: depth, strength: 10, start: 0, end: 1 }] },
      references: { paths: [ref, ref, ref, ref], maxEdge: 2048 },
      sampling: { sampler: 'heun', scheduler: 'karras', shift: 3, hires: { width: 1536, height: 1536, steps: 0, strength: 1 }, stepCache: 'fbcache', cfgTruncation: 0 },
    })
  })

  it('canonicalizes a path with dot segments that stays inside', async () => {
    const init = put(join(assets(), 'init.png'))
    const result = await validateJobInputs({ initImage: { path: join(assets(), 'sub', '..', 'init.png'), strength: 0.5 } }, context())
    expect(result.initImage?.path).toBe(init)
  })

  it('leaves the engine to judge when its features are unknown', async () => {
    const init = put(join(assets(), 'init.png'))
    await expect(validateJobInputs({ initImage: { path: init, strength: 0.5 }, sampling: { sampler: 'anything' } }, context({ features: null })))
      .resolves.toMatchObject({ sampling: { sampler: 'anything' } })
  })
})

describe('validateJobInputs: paths', () => {
  it('rejects a picture outside every allowed folder', async () => {
    const stray = put(join(outside(), 'stray.png'))
    expect(await failure({ initImage: { path: stray, strength: 0.5 } })).toEqual({
      code: 'E_INPUT_PATH', message: '起始图「stray.png」不在项目素材或作品库中，请先把它导入到画板',
    })
  })

  it('rejects a traversal out of the assets folder', async () => {
    put(join(root(), 'projects', 'p2', 'assets', 'other.png'))
    const traversal = join(assets(), '..', '..', 'p2', 'assets', 'other.png')
    expect((await failure({ references: { paths: [traversal] } })).code).toBe('E_INPUT_PATH')
  })

  it('rejects a link inside an allowed folder that points outside it', async () => {
    put(join(outside(), 'secret', 'secret.png'))
    mkdirSync(assets(), { recursive: true })
    // A directory junction needs no privilege on Windows; elsewhere it is a plain symlink.
    symlinkSync(join(outside(), 'secret'), join(assets(), 'linked'), 'junction')
    const escaped = join(assets(), 'linked', 'secret.png')
    expect(await failure({ initImage: { path: escaped, strength: 0.5 } })).toMatchObject({ code: 'E_INPUT_PATH', message: expect.stringContaining('不在项目素材或作品库中') })
  })

  it('rejects a missing file, a folder and a picture the engine cannot read', async () => {
    expect(await failure({ initImage: { path: join(assets(), 'gone.png'), strength: 0.5 } })).toEqual({
      code: 'E_INPUT_PATH', message: '起始图「gone.png」找不到了，请重新选择图片',
    })
    mkdirSync(join(assets(), 'folder.png'), { recursive: true })
    expect((await failure({ mask: { path: join(assets(), 'folder.png') }, initImage: { path: put(join(assets(), 'i.png')), strength: 1 } })).code).toBe('E_INPUT_PATH')
    const webp = put(join(assets(), 'pic.webp'), WEBP)
    expect(await failure({ references: { paths: [webp] } })).toEqual({ code: 'E_INPUT_PATH', message: '参考图 1「pic.webp」不是 PNG 或 JPEG 图片' })
  })

  it('accepts only a registered control adapter, by its resolved path', async () => {
    const depth = put(join(assets(), 'depth.png'))
    const registered = put(join(root(), 'models', 'union.safetensors'), Buffer.from('x'))
    const other = put(join(root(), 'models', 'other.safetensors'), Buffer.from('x'))
    const control = (file: string, kind = 'depth') => ({ control: { adapter: file, images: [{ kind, path: depth, strength: 1, start: 0, end: 1 }] } })
    const ctx = context({ controlAdapters: [adapter(registered)] })
    expect((await failure(control(other), ctx)).code).toBe('E_INPUT_PATH')
    expect((await failure(control(join(root(), 'models', 'gone.safetensors')), ctx)).code).toBe('E_INPUT_PATH')
    expect(await failure(control(registered, 'pose'), ctx)).toEqual({ code: 'E_INPUT', message: '「union.safetensors」不支持「pose」控制，可用：depth、canny' })
    await expect(validateJobInputs(control(join(root(), 'models', '.', 'union.safetensors')), ctx)).resolves.toMatchObject({ control: { adapter: registered } })
  })
})

describe('validateJobInputs: limits (the engine\'s, test_protocol.py)', () => {
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ['init strength above 1', { initImage: { path: '/a.png', strength: 1.5 } }, '重绘幅度需在 0 到 1 之间'],
    ['negative init strength', { initImage: { path: '/a.png', strength: -0.1 } }, '重绘幅度需在 0 到 1 之间'],
    ['unknown resize mode', { initImage: { path: '/a.png', strength: 0.5, resize: 'cover' } }, ''],
    ['mask without a start picture', { mask: { path: '/m.png' } }, '遮罩需要先设置起始图'],
    ['five references', { references: { paths: ['/1', '/2', '/3', '/4', '/5'] } }, '参考图最多 4 张'],
    ['no references', { references: { paths: [] } }, '至少需要 1 张参考图'],
    ['reference edge below 16', { references: { paths: ['/1'], maxEdge: 8 } }, '参考图边长需在 16 到 2048 之间'],
    ['fractional reference edge', { references: { paths: ['/1'], maxEdge: 512.5 } }, '参考图边长需为整数'],
    ['control strength above 10', { control: { adapter: '/c', images: [{ kind: 'depth', path: '/d', strength: 11, start: 0, end: 1 }] } }, '控制强度需在 0 到 10 之间'],
    ['start after end', { control: { adapter: '/c', images: [{ kind: 'depth', path: '/d', strength: 1, start: 0.8, end: 0.2 }] } }, '控制图的开始位置不能晚于结束位置'],
    ['two images of one kind', { control: { adapter: '/c', images: [{ kind: 'depth', path: '/d', strength: 1, start: 0, end: 1 }, { kind: 'depth', path: '/e', strength: 1, start: 0, end: 1 }] } }, '「depth」控制图只能有一张'],
    ['17 control images', { control: { adapter: '/c', images: Array.from({ length: 17 }, (_, i) => ({ kind: `k${i}`, path: '/d', strength: 1, start: 0, end: 1 })) } }, '控制图最多 16 张'],
    ['hires not a multiple of 16', { sampling: { hires: { width: 1000, height: 1024 } } }, '高清修复尺寸需为 16 的倍数'],
    ['hires strength above 1', { sampling: { hires: { width: 1024, height: 1024, strength: 2 } } }, '高清修复重绘幅度需在 0 到 1 之间'],
    ['cfg truncation above 1', { sampling: { cfgTruncation: 1.5 } }, 'CFG 截断需在 0 到 1 之间'],
    ['empty path', { initImage: { path: '  ', strength: 0.5 } }, '图片路径不能为空'],
    ['hires below 64', { sampling: { hires: { width: 48, height: 1024 } } }, '高清修复尺寸至少 64'],
    ['NUL in a path', { references: { paths: ['/a\0b.png'] } }, '图片路径不能包含 NUL'],
  ]
  for (const [label, source, message] of cases) {
    it(`rejects ${label} with E_INPUT`, async () => {
      const result = await failure(source)
      expect(result.code).toBe('E_INPUT')
      if (message) expect(result.message).toBe(message)
    })
  }
})

describe('validateJobInputs: what the engine supports', () => {
  it('refuses inputs an older engine (no 2.2 capabilities) cannot use', async () => {
    const old = context({ features: features({ imageInput: false, control: false, references: false, hires: false, samplers: false, values: {} }) })
    expect(await failure({ initImage: { path: '/a.png', strength: 0.5 } }, old)).toEqual({ code: 'E_NOT_SUPPORTED', message: '当前引擎不支持起始图，请更新 MossInfer' })
    expect((await failure({ references: { paths: ['/a.png'] } }, old)).message).toBe('当前引擎不支持参考图，请更新 MossInfer')
    expect((await failure({ sampling: { hires: { width: 1024, height: 1024 } } }, old)).message).toBe('当前引擎不支持高清修复，请更新 MossInfer')
    expect((await failure({ sampling: { sampler: 'euler' } }, old)).message).toBe('当前引擎不支持更换采样器，请更新 MossInfer')
    expect((await failure({ control: { adapter: '/c', images: [] } }, old)).message).toBe('当前引擎不支持控制图，请更新 MossInfer')
  })

  it('refuses control images on an SSH host, whatever its features say or when they are unknown', async () => {
    const refused = { code: 'E_NOT_SUPPORTED', message: '在其他电脑上运行时暂不支持控制图，请移除控制图或改回这台电脑' }
    for (const hostFeatures of [features({ control: false }), features({ control: true }), null]) {
      expect(await failure({ control: { adapter: '/c', images: [] } }, context({ remote: true, features: hostFeatures }))).toEqual(refused)
    }
  })

  it('accepts only the enum names the engine lists', async () => {
    expect(await failure({ sampling: { sampler: 'euler_a' } })).toEqual({ code: 'E_INPUT', message: '当前引擎没有「euler_a」这个采样器' })
    expect((await failure({ sampling: { scheduler: 'simple' } })).message).toBe('当前引擎没有「simple」这个调度器')
    expect((await failure({ sampling: { stepCache: 'teacache' } })).message).toBe('当前引擎没有「teacache」这个步缓存方式')
  })
})
