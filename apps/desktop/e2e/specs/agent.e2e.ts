/**
 * The Studio assistant panel: one header row (model, 自主 / 审批, history,
 * new), a waiting card raised above the input, answered questions folded to
 * one line, a plan previewed on the board until it is applied, and words in
 * the input answering whatever card waits.
 */
import { describe, expect, it } from 'vitest'
import type { Page } from 'playwright-core'
import type { AgentCard } from '@shared/agent/cards'
import type { AiConversationInfo, AiMessage } from '@shared/ai'
import { useApp, type E2eApp, type Theme } from '../support/app'

const NOW = '2026-11-08T10:00:00.000Z'
const msg = (m: Partial<AiMessage> & Pick<AiMessage, 'id' | 'role'>): AiMessage => ({ content: '', createdAt: NOW, ...m })

const PLAN: AgentCard = {
  id: 'plan',
  kind: 'plan',
  title: '按三段式排好海报',
  why: '先排版再生成。',
  steps: [
    {
      tool: 'studio_add_text_layer',
      args: { caption: 'bold dark green sans-serif title', text: 'SPRING', bbox: { x: 0.1, y: 0.05, w: 0.8, h: 0.18 } },
      label: '添加文字 · 「SPRING」',
    },
    {
      tool: 'studio_add_layer',
      args: { label: 'object', caption: 'blooming cherry branch', bbox: { x: 0.05, y: 0.3, w: 0.9, h: 0.35 } },
      label: '添加物体 · 盛开的樱花枝',
    },
    {
      tool: 'studio_add_layer',
      args: { label: 'object', caption: 'picnic basket on grass', bbox: { x: 0.25, y: 0.7, w: 0.5, h: 0.25 } },
      label: '添加物体 · 草地上的野餐篮',
    },
  ],
  createdAt: NOW,
}

const QUESTION: AgentCard = {
  id: 'ask',
  kind: 'choice',
  title: '主体放在哪里？',
  options: [
    { id: 'top', label: '上段' },
    { id: 'middle', label: '中段' },
  ],
  allowFreeText: true,
  createdAt: NOW,
}

function chat(pending: AgentCard | null, mode: 'auto' | 'advanced'): AiConversationInfo {
  return {
    id: 'chat',
    title: '春季海报',
    providerId: 'p1',
    mode,
    createdAt: NOW,
    updatedAt: NOW,
    messages: [
      msg({ id: 'u1', role: 'user', content: '做一张三段式的春季海报，标题写 SPRING' }),
      msg({
        id: 'a1',
        role: 'assistant',
        toolCalls: [
          { id: 't1', name: 'studio_read_context', arguments: '{}' },
          { id: 't2', name: 'studio_set_prompt', arguments: '{"prompt":"春日花园海报"}' },
        ],
      }),
      msg({
        id: 'r1',
        role: 'tool',
        toolCallId: 't1',
        name: 'studio_read_context',
        content: '{"canvases":[{"id":"canvas-1"}],"selected":{"title":"画面 1"}}',
      }),
      msg({ id: 'r2', role: 'tool', toolCallId: 't2', name: 'studio_set_prompt', content: '{"written":6}' }),
      msg({
        id: 'a2',
        role: 'assistant',
        content: '描述写好了。标题用哪种样式？',
        card: {
          id: 'style',
          kind: 'choice',
          title: '标题用哪种样式？',
          options: [
            { id: 'a', label: '手写体' },
            { id: 'b', label: '粗体无衬线' },
          ],
          createdAt: NOW,
          answer: { selected: ['b'] },
        },
      }),
      msg({ id: 'u2', role: 'user', content: '粗体无衬线' }),
      msg({ id: 'a3', role: 'assistant', content: '好的，排版方案在画面上。', card: pending ?? undefined }),
    ],
  }
}

async function open(app: E2eApp, conversation: AiConversationInfo | null, theme: Theme = 'light'): Promise<Page> {
  const page = await app.open({ scenario: 'ready', route: '/studio', theme, defer: true })
  await page.evaluate(
    ([seed]) => {
      window.__mock.state.aiProviders = [window.__mock.fixtures.aiProviderFixture({ id: 'p1', name: 'DeepSeek', model: 'deepseek-chat' })]
      window.__mock.state.conversations = seed ? [seed as AiConversationInfo] : []
      if (seed) {
        localStorage.setItem('mossstudio.agentConversationId', (seed as AiConversationInfo).id)
        localStorage.setItem('mossstudio.agentMode', (seed as AiConversationInfo).mode ?? 'auto')
      }
    },
    [conversation] as const,
  )
  await app.start()
  await page.getByRole('button', { name: '助手', exact: true }).click()
  await page.getByRole('group', { name: '助手模式' }).waitFor()
  return page
}

describe('assistant', () => {
  const app = useApp()

  for (const theme of ['light', 'dark'] as const) {
    it(`审批: a plan waits above the input and previews its boxes on the board until 应用 (${theme})`, async () => {
      const page = await open(app, chat(PLAN, 'advanced'), theme)
      // One header row: the model as a menu, the mode, history and new; no explanations around them.
      expect(await page.getByRole('button', { name: '语言模型' }).textContent()).toBe('DeepSeek')
      const modes = page.getByRole('group', { name: '助手模式' })
      expect(await modes.getByRole('button').allTextContents()).toEqual(['自主', '审批'])
      expect(await modes.getByRole('button', { name: '审批' }).getAttribute('aria-pressed')).toBe('true')
      for (const gone of ['两种模式的区别', 'Enter 发送', '润色描述']) {
        expect(await page.getByText(gone).count(), gone).toBe(0)
      }
      // Two user turns: one dot each, the current one marked. A single turn has no rail.
      const rail = page.getByRole('navigation', { name: '对话轮次' })
      expect(await rail.locator('button').count()).toBe(2)
      expect(await rail.locator('button[aria-current="true"]').count()).toBe(1)

      // What the assistant did, in words; the answered question folded to one line, its answer the user's bubble.
      await expect.poll(() => page.locator('[data-tool-trace]').first().getByRole('button').innerText()).toBe('查看画面、改写描述')
      expect(await page.locator('[data-answered-card]').textContent()).toBe('标题用哪种样式？')
      expect(await page.getByRole('radiogroup').count()).toBe(0)

      // The waiting plan: raised above the input, no outline, no pulse.
      const dock = page.locator('[data-pending-card]')
      expect(await dock.getByText('按三段式排好海报').isVisible()).toBe(true)
      expect(await dock.evaluate((element) => element.querySelector('.animate-pulse, [class*="ring-"]') === null)).toBe(true)
      // Its boxes, previewed on the selected 画面.
      const card = page.locator('[aria-current="true"][data-canvas-card]')
      await expect.poll(() => card.locator('[data-planned-region]').count()).toBe(3)
      // Nothing else on the face while the plan previews (the first 画面's ideas step aside).
      expect(await card.locator('[data-face-ideas]').count()).toBe(0)
      expect(await card.locator('[data-planned-region]').first().innerText()).toBe('「SPRING」')
      await app.screenshot(`agent-plan-${theme}`)

      await dock.getByRole('button', { name: '应用' }).click()
      // Applied as shown: real boxes, the preview gone, the answer recorded and the conversation carried on.
      await expect.poll(() => card.locator('[data-region-id]').count()).toBe(3)
      await expect.poll(() => card.locator('[data-planned-region]').count()).toBe(0)
      await expect
        .poll(() => app.calls<{ answer: unknown }>('ai:card-answer'))
        .toEqual([{ conversationId: 'chat', messageId: 'a3', answer: { selected: [], applied: true } }])
      await expect
        .poll(() => app.calls<{ message?: string }>('ai:chat').then((calls) => calls.at(-1)?.message))
        // The 画面 still has no description, so the follow-up says what is missing.
        .toBe('已按方案改了 3 处。还差：先写一句整体描述')
    })
  }

  it('自主: a question waits above the input, and words typed there answer it', async () => {
    const page = await open(app, chat(QUESTION, 'auto'))
    const dock = page.locator('[data-pending-card]')
    expect(await dock.getByRole('radiogroup', { name: '主体放在哪里？' }).getByRole('radio').allTextContents()).toEqual(['上段', '中段'])
    // Nothing on the board: only a plan previews.
    expect(await page.locator('[data-planned-region]').count()).toBe(0)
    const input = page.getByRole('textbox', { name: '给助手的消息' })
    expect(await input.getAttribute('placeholder')).toBe('或者直接写你的答案…')
    await app.screenshot('agent-question-light')
    await input.fill('放在中间偏左')
    await input.press('Enter')
    await expect
      .poll(() => app.calls<{ answer: unknown }>('ai:card-answer'))
      .toEqual([{ conversationId: 'chat', messageId: 'a3', answer: { selected: [], freeText: '放在中间偏左' } }])
    await expect.poll(() => app.calls<{ message?: string }>('ai:chat').then((calls) => calls.at(-1)?.message)).toBe('放在中间偏左')
  })

  it('shows the actions of a reply on hover, and ways to start only in an empty conversation', async () => {
    let page = await open(app, chat(null, 'auto'))
    const reply = page.locator('[data-message-id="a2"]')
    const actions = reply.locator('[data-reply-actions]')
    expect(await actions.evaluate((element) => getComputedStyle(element).opacity)).toBe('0')
    // They float over the reply: no room taken in the conversation.
    expect(await actions.evaluate((element) => getComputedStyle(element).position)).toBe('absolute')
    await reply.hover()
    await expect.poll(() => actions.evaluate((element) => getComputedStyle(element).opacity)).toBe('1')
    expect(await actions.getByRole('button').evaluateAll((buttons) => buttons.map((button) => button.getAttribute('aria-label')))).toEqual([
      '用作描述',
      '复制',
    ])

    page = await open(app, null)
    expect(await page.getByRole('button', { name: '润色描述' }).isVisible()).toBe(true)
    await page.getByRole('button', { name: '新对话' }).click()
    const input = page.getByRole('textbox', { name: '给助手的消息' })
    await input.fill('你好')
    await input.press('Enter')
    await expect.poll(() => page.getByRole('button', { name: '润色描述' }).count()).toBe(0)
  })

  it('the model menu switches models and opens 连接设置', async () => {
    const page = await open(app, null)
    await page.evaluate(() => undefined)
    await page.getByRole('button', { name: '语言模型' }).click()
    await page.getByRole('menuitem', { name: '连接设置…' }).click()
    await expect.poll(() => page.getByRole('dialog').first().isVisible()).toBe(true)
  })
})
