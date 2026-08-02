import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { Client } from '@notionhq/client';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
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
  methods: ['GET', 'POST', 'OPTIONS', 'HEAD'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'x-mcp-version', 'mcp-version', 'x-mcp-transport'],
  exposedHeaders: ['Content-Type', 'x-mcp-version']
}));

// Logger ghi vết tất cả các request đến từ Gemini để chẩn đoán
app.use((req, res, next) => {
  console.log(`📥 [${new Date().toISOString()}] ${req.method} ${req.url} - User-Agent: ${req.get('user-agent')} - Accept: ${req.get('accept')}`);
  next();
});

app.use(express.json());

// Khởi tạo MCP Server Instance
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

// Quản lý danh sách các Tool MCP tương tác với Notion
mcpServer.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: NOTION_TOOLS };
});

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

// Handler thực thi Tool cho MCP JSON-RPC
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

// Lưu trữ các active SSE Transports theo Session ID
const transports = new Map();

// Endpoint Health check & Keep-awake cho Render Free Tier
app.get('/health', (req, res) => {
  res.status(200).send('Notion MCP SSE Server đang hoạt động tốt.');
});

// Endpoint Discovery theo chuẩn MCP cho Gemini Client tự phát hiện
const sendMcpDiscovery = (req, res) => {
  const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  const host = req.headers['x-forwarded-host'] || req.get('host');
  const baseUrl = `${protocol}://${host}`;

  res.json({
    name: "notion-mcp-server",
    version: "1.0.0",
    protocolVersion: "2024-11-05",
    description: "Notion MCP SSE Server for Gemini Integration",
    transports: {
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

// Cung cấp OpenAPI 3.0 spec phòng trường hợp Gemini kết nối dạng Custom Action / Extension REST
app.get('/openapi.json', (req, res) => {
  const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  const host = req.headers['x-forwarded-host'] || req.get('host');
  const baseUrl = `${protocol}://${host}`;

  res.json({
    openapi: "3.0.0",
    info: {
      title: "Notion MCP Server API",
      version: "1.0.0",
      description: "Notion Workspace API for Gemini Custom Extension"
    },
    servers: [{ url: baseUrl }],
    paths: {
      "/tools/notion_search": {
        post: {
          summary: "Search Notion workspace",
          operationId: "notion_search",
          requestBody: {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { query: { type: "string" } },
                  required: ["query"]
                }
              }
            }
          },
          responses: { "200": { description: "Success" } }
        }
      },
      "/tools/notion_get_page": {
        post: {
          summary: "Get Notion page details",
          operationId: "notion_get_page",
          requestBody: {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { page_id: { type: "string" } },
                  required: ["page_id"]
                }
              }
            }
          },
          responses: { "200": { description: "Success" } }
        }
      }
    }
  });
});

// REST Endpoints cho từng Tool (cho phép Gemini gọi dạng REST Action nếu cần)
app.post('/tools/:toolName', async (req, res) => {
  try {
    const result = await executeNotionTool(req.params.toolName, req.body || {});
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Hàm xử lý SSE luồng dữ liệu thời gian thực
const handleSse = async (req, res) => {
  // Nếu Client gọi GET với Header Accept application/json, trả về Discovery JSON
  if (req.headers.accept && req.headers.accept.includes('application/json')) {
    return sendMcpDiscovery(req, res);
  }

  console.log("🔗 Khởi tạo kết nối SSE từ Client...");
  
  const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  const host = req.headers['x-forwarded-host'] || req.get('host');
  const messagesUrl = `${protocol}://${host}/messages`;

  console.log(`📡 Sending endpoint event URL: ${messagesUrl}`);

  const transport = new SSEServerTransport(messagesUrl, res);
  transports.set(transport.sessionId, transport);

  const heartbeat = setInterval(() => {
    if (!res.writableEnded) {
      res.write(': keep-alive\n\n');
    }
  }, 25000);

  transport.onclose = () => {
    console.log(`❌ Kết nối SSE bị đóng cho Session: ${transport.sessionId}`);
    clearInterval(heartbeat);
    transports.delete(transport.sessionId);
  };

  await mcpServer.connect(transport);
};

// Hỗ trợ /sse và route gốc /
app.get('/sse', handleSse);
app.get('/', handleSse);

// 2. POST /messages: Nhận và xử lý các phản hồi/yêu cầu MCP JSON-RPC từ Client
app.post('/messages', async (req, res) => {
  const sessionId = req.query.sessionId;

  if (!sessionId) {
    return res.status(400).send('Thiếu tham số sessionId trên query string.');
  }

  const transport = transports.get(sessionId);
  if (!transport) {
    return res.status(404).send(`Không tìm thấy Session SSE hợp lệ cho ID: ${sessionId}`);
  }

  await transport.handlePostMessage(req, res, req.body);
});

// Khởi chạy HTTP Server
app.listen(PORT, () => {
  console.log(`🚀 Notion MCP Hybrid Server đang chạy tại Cổng (Port): ${PORT}`);
  console.log(`📡 Endpoint SSE: http://localhost:${PORT}/sse`);
  console.log(`📩 Endpoint Messages: http://localhost:${PORT}/messages`);
  console.log(`🔎 Endpoint Discovery: http://localhost:${PORT}/.well-known/mcp.json`);
});
