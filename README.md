# Notion MCP SSE Server

Notion Model Context Protocol (MCP) Server triển khai theo giao thức **Server-Sent Events (SSE)** phục vụ kết nối **Gemini** với **Notion Workspace**.

---

## 📁 Cấu trúc dự án

```text
notion-mcp-server/
├── index.js          # Server Express + MCP SSE Server + Notion SDK
├── package.json      # Khai báo dependencies
├── .env.example      # File mẫu cấu hình biến môi trường
├── .gitignore        # Cấu hình bỏ qua node_modules và .env
└── README.md         # Hướng dẫn chi tiết
```

---

## 🚀 Hướng dẫn khởi chạy ở Local (Development)

1. Cài đặt dependencies:
   ```bash
   npm install
   ```

2. Tạo file `.env` từ `.env.example`:
   ```bash
   cp .env.example .env
   ```
   Sau đó nhập `NOTION_API_KEY` của bạn vào file `.env`.

3. Chạy server ở môi trường Local:
   ```bash
   npm run dev
   ```
   Server sẽ lắng nghe tại `http://localhost:3000/sse`.

---

## 🔑 Cách lấy Notion Integration Token (`NOTION_API_KEY`)

1. Truy cập [https://www.notion.so/my-integrations](https://www.notion.so/my-integrations).
2. Nhấn **+ New integration**.
3. Đặt tên (ví dụ `Gemini MCP Integration`), chọn Workspace của bạn và lưu lại.
4. Copy đoạn **Internal Integration Secret** (`secret_...`). Đây chính là `NOTION_API_KEY`.
5. **Quan trọng**: Trên Notion Workspace, mở trang/database mà bạn muốn cho Gemini đọc/ghi -> Nhấn dấu `...` ở góc trên bên phải -> Chọn **Connections** -> Tìm và chọn Integration vừa tạo để cấp quyền truy cập.

---

## 🌐 Triển khai lên Render.com (Production)

### 1. Push lên GitHub
```bash
git init
git add .
git commit -m "Initial commit - Notion MCP SSE Server"
git remote add origin https://github.com/<YOUR_USERNAME>/notion-mcp-sse-server.git
git branch -M main
git push -u origin main
```

### 2. Tạo Web Service trên Render.com
1. Đăng nhập [Render Dashboard](https://dashboard.render.com).
2. Nhấn **New +** -> Chọn **Web Service**.
3. Kết nối với GitHub Repo `notion-mcp-sse-server`.
4. Cấu hình:
   - **Runtime**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Instance Type**: `Free`
5. Mục **Environment Variables**:
   - `NOTION_API_KEY` = `secret_xxxxxxxxxxxxxxxxxxxxxxxx`
6. Nhấn **Create Web Service**.

### 3. URL Endpoint kết nối Gemini
Sau khi Deploy thành công, hãy dán **đúng URL này** vào Gemini:
```text
https://<TEN_APP_CUA_BAN>.onrender.com/mcp
```

> ⚠️ Gemini chỉ hỗ trợ transport **Streamable HTTP** (`POST /mcp`).
> Đường `/sse` là transport cũ (spec 2024-11-05), chỉ còn giữ cho các client cũ
> như MCP Inspector — **không dùng cho Gemini**.

---

## 🧪 Cách tự kiểm tra server (quan trọng)

Test bằng **một** request `curl` là chưa đủ: một MCP client thật luôn gửi
nhiều request liên tiếp. Hãy chạy ít nhất hai request trên **cùng một tiến trình**:

```bash
URL=https://<TEN_APP_CUA_BAN>.onrender.com/mcp
H='-H Content-Type:application/json -H Accept:application/json,text/event-stream'

# 1) initialize  -> phải trả 200
curl -s -o /dev/null -w '%{http_code}\n' -X POST $URL $H \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"test","version":"1"}}}'

# 2) tools/list  -> cũng phải trả 200 (đây là bước hay hỏng nhất)
curl -s -o /dev/null -w '%{http_code}\n' -X POST $URL $H \
  -H 'MCP-Protocol-Version: 2025-06-18' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
```

Nếu request thứ nhất trả `200` nhưng request thứ hai trả `500`, server đang
dùng lại một transport stateless cho nhiều request — đó chính là lỗi khiến
Gemini báo *"Không thể kết nối với máy chủ MCP"*.

---

## 🔐 Lưu ý bảo mật

Server này hiện **không có xác thực**. `NOTION_API_KEY` nằm ở phía server, nên
bất kỳ ai biết URL đều có thể đọc/ghi Notion Workspace của bạn qua endpoint
`/mcp`. Hãy chỉ cấp quyền cho Integration trên đúng những trang cần thiết, và
cân nhắc thêm một lớp xác thực (bearer token hoặc OAuth 2.1) trước khi dùng lâu dài.
