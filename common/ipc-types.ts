export type ApiResponse = {
  requestId?: string;
  status?: number;
  data: unknown;
  headers?: Record<string, string>;
};
