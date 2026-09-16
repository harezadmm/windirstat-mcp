import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import fs from 'fs';
import path from 'path';

// Define Protected Paths to guarantee safety
const PROTECTED_KEYWORDS = [
  'code project',
  'freelance',
  'downloads\\apk',
  'documents\\backup',
  'system32',
  'windows',
  'program files',
  'boot',
  '.git',
  'node_modules',
  '.vscode',
  '.idea'
];

function isProtected(targetPath) {
  // Split a normalized path string into its individual components
  function pathComponents(p) {
    return p.split(/[\\/]/).filter(Boolean);
  }

  function matchesKeyword(p) {
    const lower = p.toLowerCase();
    const components = pathComponents(lower);
    return PROTECTED_KEYWORDS.some(kw => {
      const kwLower = kw.toLowerCase();
      // Multi-segment keywords (contain path separator or space) use substring match
      if (/[\\/\s]/.test(kwLower)) {
        return lower.includes(kwLower);
      }
      // Single-component keywords must match an exact path segment
      return components.includes(kwLower);
    });
  }

  try {
    const resolvedPath = fs.realpathSync(path.resolve(targetPath)).toLowerCase();
    return matchesKeyword(resolvedPath);
  } catch (e) {
    if (e.code !== 'ENOENT') {
      return true;
    }

    // If path doesn't exist, fall back to basic check on normalized path
    return matchesKeyword(path.resolve(targetPath));
  }
}

function getFolderSize(dirPath, currentDepth = 0, maxDepth = 3) {
  let totalSize = 0;
  let fileCount = 0;
  let lastModified = new Date(0);

  try {
    const items = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const item of items) {
      const fullPath = path.join(dirPath, item.name);
      try {
        if (item.isDirectory()) {
          if (currentDepth < maxDepth) {
            const sub = getFolderSize(fullPath, currentDepth + 1, maxDepth);
            totalSize += sub.totalSize;
            fileCount += sub.fileCount;
            if (sub.lastModified > lastModified) lastModified = sub.lastModified;
          }
        } else if (item.isFile()) {
          const stats = fs.statSync(fullPath);
          totalSize += stats.size;
          fileCount++;
          if (stats.mtime > lastModified) lastModified = stats.mtime;
        }
      } catch (e) {
        // Silently skip locked files
      }
    }
  } catch (e) {
    // Silently skip inaccessible dirs
  }

  return { totalSize, fileCount, lastModified };
}

const server = new Server(
  {
    name: 'windirstat-mcp',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'scan_directory',
        description: 'Deep scan a directory and return subdirectories sorted by storage size in MB/GB with file counts.',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Absolute directory path to scan' },
            maxDepth: { type: 'number', description: 'Depth to recurse (default 2)' },
            minSizeMB: { type: 'number', description: 'Minimum size threshold in MB (default 50)' }
          },
          required: ['path']
        }
      },
      {
        name: 'get_largest_items',
        description: 'Find top N largest files and subfolders under a specific path.',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Absolute directory path to inspect' },
            limit: { type: 'number', description: 'Number of top items to return (default 15)' }
          },
          required: ['path']
        }
      },
      {
        name: 'categorize_safety_tiers',
        description: 'Categorize directory items into Tier 1 (100% Safe Cache/Temp), Tier 2 (Reviewable Downloads/Media), and Tier 3 (Protected Code/Projects).',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Absolute directory path to categorize' }
          },
          required: ['path']
        }
      },
      {
        name: 'clean_safe_targets',
        description: 'Safely delete specified temporary cache folders or files with built-in protection guards. Use reportOnly: true to simulate without deleting.',
        inputSchema: {
          type: 'object',
          properties: {
            targets: {
              type: 'array',
              items: { type: 'string' },
              description: 'Array of absolute file or directory paths to clean'
            },
            confirmAction: { type: 'boolean', description: 'Must be true to execute deletion' },
            reportOnly: { type: 'boolean', description: 'If true, only report what would be deleted without performing deletion' }
          },
          required: ['targets', 'confirmAction']
        }
      }
    ]
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    if (name === 'scan_directory') {
      const dirPath = args.path;
      const maxDepth = args.maxDepth || 2;
      const minSizeMB = args.minSizeMB || 50;

      if (!fs.existsSync(dirPath)) {
        return { content: [{ type: 'text', text: `Directory not found: ${dirPath}` }] };
      }

      const items = fs.readdirSync(dirPath, { withFileTypes: true });
      const results = [];

      for (const item of items) {
        const fullPath = path.join(dirPath, item.name);
        let sizeBytes = 0;
        let fileCount = 0;
        let lastMod = new Date(0);

        if (item.isDirectory()) {
          const res = getFolderSize(fullPath, 0, maxDepth);
          sizeBytes = res.totalSize;
          fileCount = res.fileCount;
          lastMod = res.lastModified;
        } else if (item.isFile()) {
          try {
            const stats = fs.statSync(fullPath);
            sizeBytes = stats.size;
            fileCount = 1;
            lastMod = stats.mtime;
          } catch (e) {}
        }

        const sizeMB = Number((sizeBytes / (1024 * 1024)).toFixed(2));
        const sizeGB = Number((sizeBytes / (1024 * 1024 * 1024)).toFixed(2));

        if (sizeMB >= minSizeMB) {
          results.push({
            name: item.name,
            path: fullPath,
            sizeMB,
            sizeGB,
            fileCount,
            lastModified: lastMod.toISOString().split('T')[0],
            isDir: item.isDirectory()
          });
        }
      }

      results.sort((a, b) => b.sizeMB - a.sizeMB);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ target: dirPath, count: results.length, items: results }, null, 2)
        }]
      };
    }

    if (name === 'get_largest_items') {
      const dirPath = args.path;
      const limit = args.limit || 15;

      if (!fs.existsSync(dirPath)) {
        return { content: [{ type: 'text', text: `Path not found: ${dirPath}` }] };
      }

      const items = fs.readdirSync(dirPath, { withFileTypes: true });
      const results = [];

      for (const item of items) {
        const fullPath = path.join(dirPath, item.name);
        let sizeBytes = 0;
        let fileCount = 0;

        if (item.isDirectory()) {
          const res = getFolderSize(fullPath, 0, 3);
          sizeBytes = res.totalSize;
          fileCount = res.fileCount;
        } else if (item.isFile()) {
          try {
            const stats = fs.statSync(fullPath);
            sizeBytes = stats.size;
            fileCount = 1;
          } catch (e) {}
        }

        results.push({
          name: item.name,
          path: fullPath,
          sizeMB: Number((sizeBytes / (1024 * 1024)).toFixed(2)),
          sizeGB: Number((sizeBytes / (1024 * 1024 * 1024)).toFixed(2)),
          fileCount,
          type: item.isDirectory() ? 'directory' : 'file'
        });
      }

      results.sort((a, b) => b.sizeMB - a.sizeMB);
      const topItems = results.slice(0, limit);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ target: dirPath, topItems }, null, 2)
        }]
      };
    }

    if (name === 'categorize_safety_tiers') {
      const dirPath = args.path;

      if (!fs.existsSync(dirPath)) {
        return { content: [{ type: 'text', text: `Path not found: ${dirPath}` }] };
      }

      const items = fs.readdirSync(dirPath, { withFileTypes: true });
      const tier1 = [];
      const tier2 = [];
      const tier3 = [];

      for (const item of items) {
        const fullPath = path.join(dirPath, item.name);
        const lowerName = item.name.toLowerCase();
        let sizeBytes = 0;

        if (item.isDirectory()) {
          sizeBytes = getFolderSize(fullPath, 0, 2).totalSize;
        } else {
          try { sizeBytes = fs.statSync(fullPath).size; } catch(e){}
        }

        const info = {
          name: item.name,
          path: fullPath,
          sizeMB: Number((sizeBytes / (1024 * 1024)).toFixed(2)),
          sizeGB: Number((sizeBytes / (1024 * 1024 * 1024)).toFixed(2))
        };

        if (isProtected(fullPath)) {
          tier3.push({ ...info, reason: 'Protected Code/Project/System Data' });
        } else if (
          lowerName.includes('temp') ||
          lowerName.includes('cache') ||
          lowerName.includes('crashdump') ||
          lowerName.includes('updater') ||
          lowerName.endsWith('.tmp') ||
          lowerName.endsWith('.log')
        ) {
          tier1.push({ ...info, reason: '100% Safe Cache / Temporary Files' });
        } else if (
          lowerName.includes('download') ||
          lowerName.endsWith('.zip') ||
          lowerName.endsWith('.rar') ||
          lowerName.endsWith('.exe') ||
          lowerName.endsWith('.msi') ||
          lowerName.endsWith('.xapk') ||
          lowerName.endsWith('.iso')
        ) {
          tier2.push({ ...info, reason: 'Reviewable Media / Downloads / Installers' });
        } else {
          tier2.push({ ...info, reason: 'User Data / Unclassified' });
        }
      }

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ target: dirPath, tier1_safe: tier1, tier2_reviewable: tier2, tier3_protected: tier3 }, null, 2)
        }]
      };
    }

    if (name === 'clean_safe_targets') {
      const { targets, confirmAction, reportOnly } = args;

      if (!confirmAction) {
        return { content: [{ type: 'text', text: 'Error: confirmAction must be true to proceed with deletion.' }] };
      }

      const results = [];
      let totalFreedBytes = 0;

      for (const targetPath of targets) {
        try {
          const requestedPath = path.resolve(targetPath);
          let deletePath = requestedPath;

          try {
            deletePath = fs.realpathSync(requestedPath);
          } catch (err) {
            if (err.code === 'ENOENT') {
              if (isProtected(targetPath)) {
                results.push({ path: targetPath, status: reportOnly ? 'WOULD_SKIP_PROTECTED' : 'SKIPPED_PROTECTED', freedMB: 0 });
              } else {
                results.push({ path: targetPath, status: 'NOT_FOUND', freedMB: 0 });
              }
              continue;
            }

            throw err;
          }

          if (isProtected(deletePath)) {
            results.push({ path: targetPath, status: reportOnly ? 'WOULD_SKIP_PROTECTED' : 'SKIPPED_PROTECTED', freedMB: 0 });
            continue;
          }

          const stats = fs.statSync(deletePath);
          let sizeBytes = 0;

          if (stats.isDirectory()) {
            sizeBytes = getFolderSize(deletePath, 0, 5).totalSize;
            if (!reportOnly) {
              fs.rmSync(deletePath, { recursive: true, force: true });
            }
          } else {
            sizeBytes = stats.size;
            if (!reportOnly) {
              fs.unlinkSync(deletePath);
            }
          }

          totalFreedBytes += sizeBytes;
          results.push({
            path: targetPath,
            status: reportOnly ? 'WOULD_DELETE' : 'DELETED_SUCCESSFULLY',
            freedMB: Number((sizeBytes / (1024 * 1024)).toFixed(2)),
            freedGB: Number((sizeBytes / (1024 * 1024 * 1024)).toFixed(2))
          });
        } catch (err) {
          results.push({ path: targetPath, status: `ERROR: ${err.message}`, freedMB: 0 });
        }
      }

      const totalFreedGB = Number((totalFreedBytes / (1024 * 1024 * 1024)).toFixed(2));

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ totalFreedGB, details: results, mode: reportOnly ? 'REPORT_ONLY' : 'EXECUTE' }, null, 2)
        }]
      };
    }

    throw new Error(`Unknown tool: ${name}`);
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error.message}` }],
      isError: true
    };
  }
});

async function runServer() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('WinDirStat MCP Server running on stdio');
}

runServer().catch(console.error);
