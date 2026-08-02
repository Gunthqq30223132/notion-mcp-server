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
Sau khi Deploy thành công, URL kết nối của bạn sẽ có dạng:
```text
https://<TEN_APP_CUA_BAN>.onrender.com/sse
```
