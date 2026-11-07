import { act, createElement, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Notice } from '@renderer/components/common/Notice'
import { PathValue } from '@renderer/components/common/PathValue'
import { PromptBlock } from '@renderer/components/common/PromptBlock'
import { Button, EmptyState, LoadingRow, ProgressBar, ToastProvider } from '@renderer/components/ui'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null
let container: HTMLElement | null = null

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  root = null
  container = null
})

function render(element: ReactElement): HTMLElement {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  act(() => root!.render(createElement(ToastProvider, null, element)))
  return container
}

const classes = (element: Element | null): string[] => (element?.getAttribute('class') ?? '').split(/\s+/)

describe('Button', () => {
  it('has an xs size below sm', () => {
    const view = render(createElement(Button, { size: 'xs' }, '添加'))
    expect(classes(view.querySelector('button'))).toContain('h-[26px]')
  })

  it('lets a className override the tone (the 删除 that rendered in ink)', () => {
    const view = render(createElement(Button, { tone: 'ghost', className: 'text-danger' }, '删除'))
    const list = classes(view.querySelector('button'))
    expect(list).toContain('text-danger')
    expect(list).not.toContain('text-ink')
  })

  it('splits danger into a solid confirm and a ghost start', () => {
    const view = render(
      createElement(
        'div',
        null,
        createElement(Button, { tone: 'danger' }, '卸载'),
        createElement(Button, { tone: 'ghost-danger' }, '删除'),
      ),
    )
    const [confirm, start] = [...view.querySelectorAll('button')]
    expect(classes(confirm!)).toEqual(expect.arrayContaining(['bg-danger', 'text-on-danger']))
    expect(classes(start!)).toEqual(expect.arrayContaining(['bg-transparent', 'text-danger', 'enabled:hover:bg-danger-soft']))
  })
})

describe('Notice', () => {
  it('uses a soft fill and an icon per tone, never a border', () => {
    for (const [tone, fill] of [
      ['info', 'bg-well'],
      ['warn', 'bg-warn-soft'],
      ['danger', 'bg-danger-soft'],
    ] as const) {
      const view = render(createElement(Notice, { tone, children: '注意' }))
      const box = view.querySelector(`[data-notice="${tone}"]`)
      expect(box?.getAttribute('role')).toBe('status')
      expect(classes(box)).toContain(fill)
      expect(classes(box).some((name) => name.startsWith('border'))).toBe(false)
      expect(box?.querySelector('svg')).not.toBeNull()
      act(() => root?.unmount())
      container?.remove()
    }
  })

  it('shows a title, the text and an action, and passes data attributes through', () => {
    const view = render(
      createElement(
        Notice,
        { tone: 'warn', title: '必须更新', action: createElement(Button, { size: 'xs' }, '更新'), 'data-app-running': true } as never,
        '这个版本已停止支持生成。',
      ),
    )
    const box = view.querySelector('[data-notice]')!
    expect(box.textContent).toBe('必须更新这个版本已停止支持生成。更新')
    expect(box.querySelector('p')?.className).toContain('font-semibold')
    expect(box.hasAttribute('data-app-running')).toBe(true)
    expect(box.querySelector('button')?.textContent).toBe('更新')
  })
})

describe('ProgressBar', () => {
  it('fills to the value when it is known', () => {
    const view = render(createElement(ProgressBar, { value: 40, label: '下载进度' }))
    const bar = view.querySelector('[role="progressbar"]')!
    expect(bar.getAttribute('aria-valuenow')).toBe('40')
    expect((bar.firstElementChild as HTMLElement).style.width).toBe('40%')
  })

  it('moves a segment when the amount is unknown, never a full bar', () => {
    const view = render(createElement(ProgressBar, { value: null, label: '正在安装' }))
    const bar = view.querySelector('[role="progressbar"]')!
    expect(bar.hasAttribute('data-indeterminate')).toBe(true)
    expect(bar.hasAttribute('aria-valuenow')).toBe(false)
    expect(bar.getAttribute('aria-busy')).toBe('true')
    const segment = bar.firstElementChild as HTMLElement
    expect(classes(segment)).toEqual(expect.arrayContaining(['ui-progress-indeterminate', 'w-[30%]', 'bg-accent']))
    expect(segment.style.width).toBe('')
  })
})

describe('PromptBlock', () => {
  it('shows the prompt in a selectable well with a copy button', async () => {
    const writeText = vi.fn(async () => undefined)
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    const view = render(createElement(PromptBlock, { title: '不想出现的内容', text: '  blurry, watermark ' }))
    const block = view.querySelector('[data-prompt-block="不想出现的内容"]')!
    expect(block.querySelector('h3')?.textContent).toBe('不想出现的内容')
    const well = block.querySelector('p')!
    expect(well.textContent).toBe('blurry, watermark')
    expect(classes(well)).toEqual(expect.arrayContaining(['selectable', 'bg-well']))
    const copy = block.querySelector('button[aria-label="复制不想出现的内容"]') as HTMLButtonElement
    await act(async () => copy.click())
    expect(writeText).toHaveBeenCalledWith('blurry, watermark')
  })

  it('says when there is nothing and offers no copy', () => {
    const view = render(createElement(PromptBlock, { title: '描述', text: '  ', empty: '没有记录描述' }))
    expect(view.querySelector('p')?.textContent).toBe('没有记录描述')
    expect(view.querySelector('button')).toBeNull()
  })
})

describe('PathValue', () => {
  it('shows a path in mono in a well, with the full value on hover', () => {
    const view = render(createElement(PathValue, { value: '/data/models', suffix: '（默认）' }))
    const text = view.querySelector('[data-path-value] > span')!
    expect(text.textContent).toBe('/data/models（默认）')
    expect(text.getAttribute('title')).toBe('/data/models')
    expect(classes(text)).toEqual(expect.arrayContaining(['font-mono', 'truncate', 'selectable']))
    expect(classes(view.querySelector('[data-path-value]'))).toContain('bg-well')
    expect(view.querySelector('button')).toBeNull()
  })

  it('falls back to the empty text and can offer a copy button', () => {
    expect(render(createElement(PathValue, { value: null, empty: '默认位置', suffix: '（默认）' })).textContent).toBe('默认位置')
    act(() => root?.unmount())
    expect(
      render(createElement(PathValue, { value: 'ssh://host', copy: true }))
        .querySelector('button')
        ?.getAttribute('aria-label'),
    ).toBe('复制')
  })
})

describe('LoadingRow and EmptyState', () => {
  it('says what is loading next to a spinner', () => {
    const view = render(createElement(LoadingRow, null))
    const row = view.querySelector('[role="status"]')!
    expect(row.textContent).toBe('正在读取…')
    expect(row.querySelector('svg')).not.toBeNull()
    act(() => root?.unmount())
    expect(render(createElement(LoadingRow, { label: '正在检查…' })).textContent).toBe('正在检查…')
  })

  it('has a page size and a section size', () => {
    const page = render(createElement(EmptyState, { title: '还没有任务', description: '生成后会出现在这里。' }))
    expect(classes(page.firstElementChild)).toContain('py-14')
    expect(classes(page.querySelector('p'))).toContain('text-control')
    act(() => root?.unmount())
    const section = render(createElement(EmptyState, { title: '还没有 LoRA', size: 'section' }))
    expect(classes(section.firstElementChild)).toContain('py-6')
    expect(classes(section.querySelector('p'))).toContain('text-ui')
  })
})
