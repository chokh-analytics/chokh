export interface HealthStatus {
  status: 'ok';
  uptimeMs: number;
}

export function getHealth(): HealthStatus {
  return {
    status: 'ok',
    uptimeMs: Math.round(process.uptime() * 1000),
  };
}
