import { open, realpath, stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { CLI_ENGINE_LABEL, cliSamplingAccepted } from '@shared/cliEngine'
import { jobInputsSchema } from '@shared/schemas'
import type { ControlAdapterEntry, EngineFeatures, JobParams } from '@shared/types'
import { codedError } from '../lib/codedError'
import { isInside } from '../lib/paths'

/**
 * Checks the pictures and settings a generation asks for before it is queued:
 * the same limits as the engine (so the answer is readable), what the target
 * engine supports, and that every file is one the app handed out itself.
 * Image paths must resolve (symlinks included) inside an allowed folder; the
 * control adapter must be a registered one.
 */

export type JobInputs = Pick<JobParams, 'initImage' | 'mask' | 'control' | 'references' | 'sampling'>

export interface JobInputContext {
  /** Folders input pictures may come from: the project's assets, outputs, gallery folders. */
  imageRoots: string[]
  controlAdapters: ControlAdapterEntry[]
  /** The target engine's features; null/undefined = unknown (the engine itself will judge). */
  features?: EngineFeatures | null
  /** Runs on an SSH host (pictures are uploaded there). */
  remote?: boolean
}

export function pickJobInputs(source: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of ['initImage', 'mask', 'control', 'references', 'sampling'] as const) {
    if (source[key] !== undefined && source[key] !== null) out[key] = source[key]
  }
  return out
}

async function canonicalRoots(roots: string[]): Promise<string[]> {
  const resolved = await Promise.all(roots.map((root) => realpath(root).catch(() => null)))
  return resolved.filter((root): root is string => root !== null)
}

/** PNG or JPEG by signature: the only formats the engine reads. */
async function readableByEngine(path: string): Promise<boolean> {
  const handle = await open(path, 'r')
  try {
    const head = Buffer.alloc(8)
    const { bytesRead } = await handle.read(head, 0, 8, 0)
    const png = bytesRead === 8 && head.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    const jpeg = bytesRead >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff
    return png || jpeg
  } finally {
    await handle.close()
  }
}

async function checkImage(path: string, label: string, roots: string[]): Promise<string> {
  const name = basename(path)
  let real: string
  try {
    real = await realpath(path)
    if (!(await stat(real)).isFile()) throw new Error('not a file')
  } catch {
    throw codedError('E_INPUT_PATH', `${label}「${name}」找不到了，请重新选择图片`)
  }
  if (!roots.some((root) => isInside(root, real))) {
    throw codedError('E_INPUT_PATH', `${label}「${name}」不在项目素材或作品库中，请先把它导入到画板`)
  }
  if (!(await readableByEngine(real))) {
    throw codedError('E_INPUT_PATH', `${label}「${name}」不是 PNG 或 JPEG 图片`)
  }
  return real
}

function unsupported(message: string): Error {
  return codedError('E_NOT_SUPPORTED', message)
}

function checkFeatures(inputs: JobInputs, features: EngineFeatures, remote: boolean): void {
  const where = remote ? '这台电脑上的引擎' : '当前引擎'
  // A CLI engine never gains these with an update: it only does text to image.
  const missing = (what: string): Error =>
    features.cli
      ? unsupported(`${CLI_ENGINE_LABEL[features.cli]}引擎只能文生图，不支持${what}，请移除后再生成`)
      : unsupported(`${where}不支持${what}，请更新 MossInfer`)
  if ((inputs.initImage || inputs.mask) && !features.imageInput) throw missing('起始图')
  if (inputs.control && !features.control) throw missing('控制图')
  if (inputs.references && !features.references) throw missing('参考图')
  const sampling = inputs.sampling
  if (sampling?.hires && !features.hires) throw missing('高清修复')
  // A CLI engine runs euler with the MOSS schedule: naming exactly those is not a change.
  const samplerChange = features.cli ? !cliSamplingAccepted(sampling) : Boolean(sampling?.sampler || sampling?.scheduler)
  if (samplerChange && !features.samplers) throw missing('更换采样器')
  if (features.cli && sampling?.stepCache && sampling.stepCache !== 'off') throw missing('步缓存')
  if (features.cli && sampling?.cfgTruncation !== undefined) throw missing('CFG 截断')
  const oneOf = (param: string, value: string | undefined, label: string): void => {
    const names = features.values[param]
    if (value === undefined || !names?.length || names.includes(value)) return
    throw codedError('E_INPUT', `${where}没有「${value}」这个${label}`)
  }
  oneOf('sampler', sampling?.sampler, '采样器')
  oneOf('scheduler', sampling?.scheduler, '调度器')
  oneOf('step_cache', sampling?.stepCache, '步缓存方式')
  oneOf('resize', inputs.initImage?.resize, '裁剪方式')
}

/**
 * Validates and canonicalizes a job's inputs; returns them with every path
 * symlink-resolved (what the engine will be told to read). Throws an Error
 * with `code` E_INPUT, E_INPUT_PATH or E_NOT_SUPPORTED and a message in Chinese.
 */
export async function validateJobInputs(source: Record<string, unknown>, context: JobInputContext): Promise<JobInputs> {
  const parsed = jobInputsSchema.safeParse(pickJobInputs(source))
  if (!parsed.success) throw codedError('E_INPUT', parsed.error.issues[0]?.message ?? '生成参数不正确')
  const inputs = parsed.data as JobInputs
  // Control adapters are local files; an SSH host cannot read them, whatever its hello says (or failed to say).
  if (context.remote && inputs.control) {
    throw unsupported('在其他电脑上运行时暂不支持控制图，请移除控制图或改回这台电脑')
  }
  if (context.features) checkFeatures(inputs, context.features, Boolean(context.remote))
  const roots = await canonicalRoots(context.imageRoots)
  const out: JobInputs = { ...inputs }
  if (inputs.initImage) out.initImage = { ...inputs.initImage, path: await checkImage(inputs.initImage.path, '起始图', roots) }
  if (inputs.mask) out.mask = { path: await checkImage(inputs.mask.path, '遮罩', roots) }
  if (inputs.control) {
    let adapterPath: string | null = null
    try {
      adapterPath = await realpath(inputs.control.adapter)
    } catch {
      adapterPath = null
    }
    const registered = await Promise.all(
      context.controlAdapters.map(async (entry) => ({
        entry,
        real: await realpath(entry.path).catch(() => null),
      })),
    )
    const adapter = registered.find((item) => item.real !== null && item.real === adapterPath)?.entry
    if (!adapterPath || !adapter) {
      throw codedError('E_INPUT_PATH', `控制适配器「${basename(inputs.control.adapter)}」没有登记或已被移动，请到模型页重新添加`)
    }
    for (const image of inputs.control.images) {
      if (adapter.controlKinds.length && !adapter.controlKinds.includes(image.kind)) {
        throw codedError('E_INPUT', `「${adapter.name}」不支持「${image.kind}」控制，可用：${adapter.controlKinds.join('、')}`)
      }
    }
    const images = []
    for (const image of inputs.control.images)
      images.push({ ...image, path: await checkImage(image.path, `控制图（${image.kind}）`, roots) })
    out.control = { ...inputs.control, adapter: adapterPath, images }
  }
  if (inputs.references) {
    const paths = []
    for (const [index, path] of inputs.references.paths.entries()) paths.push(await checkImage(path, `参考图 ${index + 1}`, roots))
    out.references = { ...inputs.references, paths }
  }
  return Object.fromEntries(Object.entries(out).filter(([, value]) => value !== undefined)) as JobInputs
}
