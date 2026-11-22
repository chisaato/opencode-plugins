import type { ManagedTask, MuxBackend, ServiceAction, TaskRole, TaskStatus } from "@misakacloud/opencode-mux-core"

export interface TaskView extends ManagedTask {
  attachCommand: string
}

export interface HealthResponse {
  ok: true
  backend: MuxBackend | null
}

export interface TasksResponse {
  tasks: TaskView[]
  backend: MuxBackend | null
}

export interface RunBuildBody {
  name: string
  command: string
  cwd: string
  wait?: boolean
  timeoutMs?: number
  tailLines?: number
}

export interface RunBuildHttpResponse {
  ok: boolean
  task: TaskView
  tail: string
  timedOut: boolean
}

export interface ServiceActionBody {
  action: ServiceAction
  name: string
  cwd: string
  command?: string
  restartIfRunning?: boolean
  force?: boolean
  timeoutMs?: number
}

export interface ServiceActionHttpResponse {
  ok: boolean
  task?: TaskView
  timedOut?: boolean
}

export interface RestartTaskBody {
  command?: string
}

export interface StopTaskBody {
  force?: boolean
  timeoutMs?: number
}

export interface LogsResponse {
  id: string
  status: TaskStatus
  exitCode?: number
  tail: string
  attachCommand: string
}

export interface InputBody {
  input: string
  enter?: boolean
}

export interface PruneBody {
  cwd?: string
  role?: TaskRole
}

export interface PruneResponse {
  pruned: ManagedTask[]
}

export interface SessionCloseBody {
  cwd: string
}

export interface SessionCloseResponse {
  ok: true
  removed: number
  sessionName: string
}

export interface ErrorResponse {
  error: string
}
