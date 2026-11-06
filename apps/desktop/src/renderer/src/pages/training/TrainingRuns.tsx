import { GraduationCap } from 'lucide-react'
import { useMemo } from 'react'
import { relative } from '../../lib/format'
import { useShell } from '../../lib/shell'
import { useApp } from '../../store'
import { Button, EmptyState, Group, Pill, ProgressBar, Row, Section } from '../../components/ui'
import { trainingRuns } from './trainingRunsModel'

/** Real training job records for one location, with their logs one click away. */
export function TrainingRuns({ hostId }: { hostId: string }): React.JSX.Element {
  const jobs = useApp((state) => state.jobs)
  const openActivity = useShell((state) => state.openActivity)
  const runs = useMemo(() => trainingRuns(jobs, hostId), [jobs, hostId])

  return (
    <Section title="训练记录">
      {runs.length === 0 ? (
        <Group>
          <EmptyState
            icon={<GraduationCap className="size-8" strokeWidth={1.6} />}
            title="还没有训练"
            description="点「新建训练」，选好图片和底模就可以开始。训练进度和日志会显示在这里。"
            className="py-10"
          />
        </Group>
      ) : (
        <Group>
          {runs.map((run) => (
            <Row
              key={run.id}
              title={run.name}
              description={
                <span className="flex flex-col gap-1.5">
                  <span className="tabular">
                    {run.algo} · {run.progressLabel} 步 · {relative(run.startedAt)}
                  </span>
                  {run.active ? <ProgressBar value={run.percent} label={`${run.name} 训练进度`} className="max-w-[320px]" /> : null}
                </span>
              }
            >
              <Pill tone={run.tone} className="tabular">
                {run.stateLabel}
              </Pill>
              <Button tone="ghost" onClick={() => openActivity('jobs', run.id)}>
                查看日志
              </Button>
            </Row>
          ))}
        </Group>
      )}
    </Section>
  )
}
