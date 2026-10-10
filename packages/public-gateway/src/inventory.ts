import { readFileSync } from 'node:fs';

export type RouteClass = 'read' | 'public' | 'full' | 'write' | 'admin';

export type ApiRoute = {
  method: string;
  /** Route template with the `/api` prefix, e.g. `/api/assets/{id}` */
  path: string;
  operationId?: string;
  permission?: string;
  class: RouteClass;
};

// Permissions that only expose data. Everything else that is not admin-only is treated as a write.
const READ_SUFFIXES = ['.read', '.view', '.download', '.statistics', '.search', '.get'];
const READ_PERMISSIONS = new Set(['server.about', 'server.apkLinks', 'server.storage', 'server.versionCheck']);

const METHODS = ['get', 'head', 'post', 'put', 'patch', 'delete'] as const;

type Operation = {
  operationId?: string;
  security?: unknown[];
  'x-immich-admin-only'?: boolean;
  'x-immich-permission'?: string;
};

export const classifyOperation = (op: Operation): RouteClass => {
  if (!op.security?.length) {
    return 'public';
  }
  if (op['x-immich-admin-only']) {
    return 'admin';
  }
  const permission = op['x-immich-permission'];
  if (permission === undefined) {
    // defaults to the `all` permission, which a read-only API key never has
    return 'full';
  }
  if (READ_PERMISSIONS.has(permission) || READ_SUFFIXES.some((suffix) => permission.endsWith(suffix))) {
    return 'read';
  }
  return 'write';
};

export const loadInventory = (specPath: string): ApiRoute[] => {
  const spec = JSON.parse(readFileSync(specPath, 'utf8')) as { paths: Record<string, Record<string, Operation>> };
  const routes: ApiRoute[] = [];
  for (const [path, item] of Object.entries(spec.paths)) {
    for (const method of METHODS) {
      const op = item[method];
      if (!op) {
        continue;
      }
      routes.push({
        method: method.toUpperCase(),
        path: `/api${path}`,
        operationId: op.operationId,
        permission: op['x-immich-permission'],
        class: classifyOperation(op),
      });
    }
  }
  return routes.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));
};
