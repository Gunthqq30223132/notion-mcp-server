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
const PROTOCOL_VERSION = '2025-06-18';

if (!NOTION_API_KEY) {
  console.warn("⚠️ CẢNH BÁO: NOTION_API_KEY chưa được khai báo trong biến môi trường!");
}

// Khởi tạo Notion SDK Client
const notion = new Client({
  auth: NOTION_API_KEY,
});

// Khởi tạo Express App
const app = express();

// Cấu hình CORS cho Gemini Client.
// mcp-session-id phải nằm trong exposedHeaders để client đọc được session sau initialize.
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS', 'HEAD', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'mcp-session-id', 'mcp-protocol-version', 'last-event-id'],
  exposedHeaders: ['Content-Type', 'mcp-session-id', 'mcp-protocol-version', 'www-authenticate']
}));

// Logger ghi vết tất cả các request đến từ Gemini để chẩn đoán
app.use((req, res, next) => {
  console.log(`📥 [${new Date().toISOString()}] ${req.method} ${req.url} - UA: ${req.get('user-agent')} - Accept: ${req.get('accept')} - Session: ${req.get('mcp-session-id') || '-'}`);
  next();
});

app.use(express.json({ limit: '4mb' }));

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
  if (!NOTION_API_KEY) {
    throw new Error("NOTION_API_KEY chưa được cấu hình trên server.");
  }

  switch (name) {
    case "notion_search":
      return await notion.search({ query: args.query, page_size: 10 });
    case "notion_get_page":
      return await notion.pages.retrieve({ page_id: args.page_id });
    case "notion_get_block_children": {
      const blocks = await notion.blocks.children.list({ block_id: args.block_id });
      return blocks.results;
    }
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
    case "notion_query_database": {
      const db = await notion.databases.query({ database_id: args.database_id, page_size: 10 });
      return db.results;
    }
    default:
      throw new Error(`Tool không hợp lệ: ${name}`);
  }
}

/**
 * Tạo MỘT instance MCP Server mới.
 *
 * QUAN TRỌNG: mỗi transport phải có Server instance riêng.
 * SDK ném lỗi "Already connected to a transport" nếu gọi connect() hai lần
 * trên cùng một Server — lỗi này là một async throw, nó làm sập cả tiến trình Node.
 */
function createMcpServer() {
  const server = new Server(
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

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: NOTION_TOOLS };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      const result = await executeNotionTool(name, args ?? {});
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

  return server;
}

// Endpoint Health check & Keep-awake cho Render Free Tier
app.get('/health', (req, res) => {
  res.status(200).send('Notion MCP Server đang hoạt động tốt.');
});

// Metadata mô tả server — chỉ dùng cho con người debug bằng trình duyệt/curl.
// Đây KHÔNG phải là một phần của giao thức MCP; client thật luôn dùng POST /mcp.
const sendMcpDiscovery = (req, res) => {
  const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  const host = req.headers['x-forwarded-host'] || req.get('host');
  const baseUrl = `${protocol}://${host}`;

  res.status(200).json({
    status: "ok",
    name: "notion-mcp-server",
    version: "1.0.0",
    protocolVersion: PROTOCOL_VERSION,
    description: "Notion MCP Server for Gemini Integration",
    transport: "streamable-http",
    endpoint: `${baseUrl}/mcp`,
    tools: NOTION_TOOLS.map((t) => t.name)
  });
};

app.get('/.well-known/mcp.json', sendMcpDiscovery);
app.get('/mcp.json', sendMcpDiscovery);

/**
 * POST /mcp — Streamable HTTP, chế độ STATELESS.
 *
 * Mỗi request HTTP phải có Server + Transport HOÀN TOÀN MỚI.
 * StreamableHTTPServerTransport ở chế độ stateless tự ném lỗi
 * "Stateless transport cannot be reused across requests" nếu bị dùng lại
 * cho request thứ hai → HTTP 500. Đây chính là nguyên nhân khiến Gemini
 * bắt tay thất bại trong khi curl một-phát-một vẫn thấy 200 OK.
 */
const handleMcpPost = async (req, res) => {
  const server = createMcpServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless
  });

  res.on('close', () => {
    transport.close().catch(() => {});
    server.close().catch(() => {});
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("❌ Lỗi xử lý POST /mcp:", err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: `Internal server error: ${err.message}` },
        id: null,
      });
    }
  }
};

/**
 * GET /mcp — theo spec, server không mở luồng SSE chủ động thì PHẢI trả 405.
 * Trả 200 + JSON ở đây là sai spec và làm client MCP nghiêm ngặt bỏ cuộc.
 */
const handleMcpGet = (req, res) => {
  const accept = req.headers.accept || '';

  // Người dùng mở bằng trình duyệt / curl thường -> trả metadata cho dễ debug.
  if (!accept.includes('text/event-stream')) {
    return sendMcpDiscovery(req, res);
  }

  res.status(405).set('Allow', 'POST, DELETE').json({
    jsonrpc: "2.0",
    error: {
      code: -32000,
      message: "Method Not Allowed: server không cung cấp luồng SSE độc lập. Hãy dùng POST /mcp (Streamable HTTP).",
    },
    id: null,
  });
};

app.post('/mcp', handleMcpPost);
app.get('/mcp', handleMcpGet);
// Stateless: không có session nào để huỷ, xác nhận thành công để client kết thúc sạch.
app.delete('/mcp', (req, res) => res.status(204).end());

// Lưu trữ các active SSE Transports theo Session ID cho Legacy SSE
const sseTransports = new Map();

/**
 * GET /sse — transport SSE cũ (spec 2024-11-05).
 * Gemini KHÔNG dùng đường này (chỉ hỗ trợ Streamable HTTP), giữ lại cho
 * các client cũ như một số phiên bản MCP Inspector.
 */
const handleSse = async (req, res) => {
  console.log("🔗 Khởi tạo kết nối Legacy SSE từ Client...");

  let transport;
  try {
    transport = new SSEServerTransport('/messages', res);
    const server = createMcpServer(); // Server RIÊNG cho mỗi kết nối
    sseTransports.set(transport.sessionId, transport);

    const heartbeat = setInterval(() => {
      if (!res.writableEnded) {
        res.write(': keep-alive\n\n');
      }
    }, 25000);

    // KHÔNG gọi server.close() ở đây: Protocol.close() sẽ gọi ngược transport.close(),
    // transport.close() lại kích hoạt onclose -> đệ quy vô hạn (Maximum call stack).
    // Protocol._onclose() đã tự dọn dẹp khi transport đóng.
    let cleanedUp = false;
    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      console.log(`❌ Kết nối SSE đóng cho Session: ${transport.sessionId}`);
      clearInterval(heartbeat);
      sseTransports.delete(transport.sessionId);
    };

    transport.onclose = cleanup;
    res.on('close', cleanup);

    await server.connect(transport);
  } catch (err) {
    console.error("❌ Lỗi khởi tạo SSE:", err);
    if (transport) sseTransports.delete(transport.sessionId);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    } else if (!res.writableEnded) {
      res.end();
    }
  }
};

app.get('/sse', handleSse);

// POST /messages: kênh gửi JSON-RPC ngược lại cho phiên SSE cũ
app.post('/messages', async (req, res) => {
  const sessionId = req.query.sessionId;

  if (!sessionId) {
    return res.status(400).send('Thiếu tham số sessionId trên query string.');
  }

  const transport = sseTransports.get(sessionId);
  if (!transport) {
    return res.status(404).send(`Không tìm thấy Session SSE hợp lệ cho ID: ${sessionId}`);
  }

  try {
    await transport.handlePostMessage(req, res, req.body);
  } catch (err) {
    console.error("❌ Lỗi xử lý POST /messages:", err);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    }
  }
});

// Route gốc: POST được coi như /mcp để client cấu hình nhầm URL vẫn chạy được
app.post('/', handleMcpPost);
app.get('/', sendMcpDiscovery);

// Error handler cuối cùng của Express
app.use((err, req, res, next) => {
  console.error("❌ Express error:", err);
  if (res.headersSent) return next(err);
  res.status(500).json({
    jsonrpc: "2.0",
    error: { code: -32603, message: `Internal server error: ${err.message}` },
    id: null,
  });
});

// Lưới an toàn: không để một lỗi lẻ làm sập tiến trình và khiến Render restart
process.on('uncaughtException', (err) => {
  console.error("🛑 uncaughtException (server vẫn tiếp tục chạy):", err);
});
process.on('unhandledRejection', (err) => {
  console.error("🛑 unhandledRejection (server vẫn tiếp tục chạy):", err);
});

// Khởi chạy HTTP Server
app.listen(PORT, () => {
  console.log(`🚀 Notion MCP Server (Streamable HTTP, stateless) đang chạy tại Cổng: ${PORT}`);
  console.log(`⚡️ Endpoint cho Gemini: POST /mcp`);
  console.log(`📡 Endpoint SSE cũ (không dùng cho Gemini): GET /sse`);
});
