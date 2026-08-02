import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { Client } from '@notionhq/client';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

dotenv.config();

const PORT = process.env.PORT || 3000;
const NOTION_API_KEY = process.env.NOTION_API_KEY;

if (!NOTION_API_KEY) {
  console.warn("⚠️ CẢNH BÁO: NOTION_API_KEY chưa được khai báo trong biến môi trường!");
}

// Khởi tạo Notion SDK Client
const notion = new Client({
  auth: NOTION_API_KEY,
});

// Khởi tạo Express App
const app = express();

// Cấu hình CORS mở rộng toàn diện cho Gemini Client
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS', 'HEAD', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'x-mcp-version', 'mcp-version', 'x-mcp-transport', 'mcp-session-id', 'MCP-Protocol-Version'],
  exposedHeaders: ['Content-Type', 'x-mcp-version', 'mcp-session-id']
}));

// Logger ghi vết tất cả các request đến từ Gemini để chẩn đoán
app.use((req, res, next) => {
  console.log(`📥 [${new Date().toISOString()}] ${req.method} ${req.url} - User-Agent: ${req.get('user-agent')} - Accept: ${req.get('accept')}`);
  next();
});

app.use(express.json());

const NOTION_TOOLS = [
  {
    name: "notion_search",
    description: "Tìm kiếm trang (Pages) hoặc cơ sở dữ liệu (Databases) trong Notion Workspace",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Từ khóa cần tìm kiếm"
        }
      },
      required: ["query"]
    }
  },
  {
    name: "notion_get_page",
    description: "Lấy chi tiết thuộc tính của một Trang (Page ID) trong Notion",
    inputSchema: {
      type: "object",
      properties: {
        page_id: {
          type: "string",
          description: "ID của trang Notion"
        }
      },
      required: ["page_id"]
    }
  },
  {
    name: "notion_get_block_children",
    description: "Lấy nội dung các khối (Blocks/Nội dung văn bản) bên trong một Trang hoặc Block ID",
    inputSchema: {
      type: "object",
      properties: {
        block_id: {
          type: "string",
          description: "ID của khối hoặc ID của trang Notion"
        }
      },
      required: ["block_id"]
    }
  },
  {
    name: "notion_append_block_children",
    description: "Thêm nội dung văn bản (Paragraph Block) vào cuối một trang Notion",
    inputSchema: {
      type: "object",
      properties: {
        block_id: {
          type: "string",
          description: "ID của trang hoặc khối cần chèn nội dung"
        },
        text: {
          type: "string",
          description: "Nội dung văn bản cần thêm vào"
        }
      },
      required: ["block_id", "text"]
    }
  },
  {
    name: "notion_query_database",
    description: "Truy vấn các bản ghi (Rows) trong một Database của Notion",
    inputSchema: {
      type: "object",
      properties: {
        database_id: {
          type: "string",
          description: "ID của Notion Database"
        }
      },
      required: ["database_id"]
    }
  }
];

// Hàm thực thi các Tool của Notion
async function executeNotionTool(name, args) {
  if (!process.env.NOTION_API_KEY) {
    throw new Error("NOTION_API_KEY chưa được cấu hình trên server.");
  }

  switch (name) {
    case "notion_search":
      return await notion.search({ query: args.query, page_size: 10 });
    case "notion_get_page":
      return await notion.pages.retrieve({ page_id: args.page_id });
    case "notion_get_block_children":
      const blocks = await notion.blocks.children.list({ block_id: args.block_id });
      return blocks.results;
    case "notion_append_block_children":
      return await notion.blocks.children.append({
        block_id: args.block_id,
        children: [
          {
            object: 'block',
            type: 'paragraph',
            paragraph: {
              rich_text: [{ type: 'text', text: { content: args.text } }],
            },
          },
        ],
      });
    case "notion_query_database":
      const db = await notion.databases.query({ database_id: args.database_id, page_size: 10 });
      return db.results;
    default:
      throw new Error(`Tool không hợp lệ: ${name}`);
  }
}

// Factory khởi tạo một McpServer Instance hoàn chỉnh sẵn sàng bind vào Transport
function createMcpServer() {
  const mcpServer = new Server(
    {
      name: "notion-mcp-server",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  mcpServer.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: NOTION_TOOLS };
  });

  mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      const result = await executeNotionTool(name, args);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    } catch (error) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Notion API Error: ${error.message}`,
          },
        ],
      };
    }
  });

  return mcpServer;
}

// Lưu trữ các active SSE Transports theo Session ID cho Legacy SSE
const sseTransports = new Map();

// Endpoint Health check & Keep-awake cho Render Free Tier
app.get('/health', (req, res) => {
  res.status(200).send('Notion MCP Server đang hoạt động tốt.');
});

// Endpoint Discovery theo chuẩn MCP
const sendMcpDiscovery = (req, res) => {
  const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  const host = req.headers['x-forwarded-host'] || req.get('host');
  const baseUrl = `${protocol}://${host}`;

  res.status(200).json({
    status: "ok",
    name: "notion-mcp-server",
    version: "1.0.0",
    protocolVersion: "2025-06-18",
    description: "Notion MCP Server for Gemini Integration",
    transports: {
      streamableHttp: {
        url: `${baseUrl}/mcp`
      },
      sse: {
        url: `${baseUrl}/sse`
      }
    },
    capabilities: {
      tools: NOTION_TOOLS
    }
  });
};

app.get('/.well-known/mcp.json', sendMcpDiscovery);
app.get('/.well-known/mcp', sendMcpDiscovery);
app.get('/mcp.json', sendMcpDiscovery);

// Xử lý StreamableHTTP endpoint (chuẩn giao thức mới của Gemini MCP)
const handleStreamableHttp = async (req, res) => {
  // Nếu là GET request không chứa text/event-stream -> trả về MCP discovery metadata 200 OK ngay!
  if (req.method === 'GET') {
    const accept = req.headers.accept || '';
    if (!accept.includes('text/event-stream')) {
      return sendMcpDiscovery(req, res);
    }
  }

  try {
    if (req.headers.accept && !req.headers.accept.includes('text/event-stream') && !req.headers.accept.includes('*/*')) {
      req.headers.accept = `${req.headers.accept}, text/event-stream`;
    }

    const mcpServer = createMcpServer();
    const transport = new StreamableHTTPServerTransport();
    await mcpServer.connect(transport);

    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("StreamableHTTP error:", err);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    }
  }
};

app.all('/mcp', handleStreamableHttp);

// Hàm xử lý SSE luồng dữ liệu thời gian thực cho legacy clients
const handleSse = async (req, res) => {
  const accept = req.headers.accept || '';
  if (!accept.includes('text/event-stream')) {
    return sendMcpDiscovery(req, res);
  }

  if (req.method === 'POST' || req.headers['mcp-session-id']) {
    return handleStreamableHttp(req, res);
  }

  console.log("🔗 Khởi tạo kết nối Legacy SSE từ Client...");
  
  const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  const host = req.headers['x-forwarded-host'] || req.get('host');
  const messagesUrl = `${protocol}://${host}/messages`;

  const mcpServer = createMcpServer();
  const transport = new SSEServerTransport(messagesUrl, res);
  sseTransports.set(transport.sessionId, { mcpServer, transport });

  const heartbeat = setInterval(() => {
    if (!res.writableEnded) {
      res.write(': keep-alive\n\n');
    }
  }, 25000);

  transport.onclose = () => {
    console.log(`❌ Kết nối SSE bị đóng cho Session: ${transport.sessionId}`);
    clearInterval(heartbeat);
    sseTransports.delete(transport.sessionId);
  };

  await mcpServer.connect(transport);
};

app.all('/sse', handleSse);

// Route gốc / tự động chọn StreamableHTTP, SSE hoặc Discovery tùy theo request
app.all('/', async (req, res) => {
  if (req.method === 'POST') {
    return handleStreamableHttp(req, res);
  }
  const accept = req.headers.accept || '';
  if (accept.includes('text/event-stream')) {
    return handleSse(req, res);
  }
  return sendMcpDiscovery(req, res);
});

// 2. POST /messages: Nhận và xử lý các phản hồi/yêu cầu MCP JSON-RPC từ Legacy SSE Client
app.post('/messages', async (req, res) => {
  const sessionId = req.query.sessionId;

  if (!sessionId) {
    return res.status(400).send('Thiếu tham số sessionId trên query string.');
  }

  const session = sseTransports.get(sessionId);
  if (!session) {
    return res.status(404).send(`Không tìm thấy Session SSE hợp lệ cho ID: ${sessionId}`);
  }

  await session.transport.handlePostMessage(req, res, req.body);
});

// Khởi chạy HTTP Server
app.listen(PORT, () => {
  console.log(`🚀 Notion MCP Universal Server (StreamableHTTP + SSE + Discovery) đang chạy tại Cổng: ${PORT}`);
  console.log(`⚡️ Endpoint StreamableHTTP: http://localhost:${PORT}/mcp`);
  console.log(`📡 Endpoint SSE: http://localhost:${PORT}/sse`);
});
