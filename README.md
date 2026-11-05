# Bài Nhà — quản lý lớp IELTS/TOEIC

Ứng dụng web cho giáo viên và học sinh: giao bài bằng sách, ảnh, PDF hoặc Word; nộp ảnh bài làm; chấm và nhận xét trực tiếp trên ảnh; điểm danh và báo cáo theo học sinh; nhập đề PDF và làm bài trắc nghiệm.

## Chạy local

Yêu cầu **Node.js 24.16+** có `node:sqlite`.

```sh
npm install --ignore-scripts
npm start
```

Mở http://127.0.0.1:4173/. Với thư mục dữ liệu mới, tạo tài khoản giáo viên ở lần chạy đầu; giáo viên tạo tài khoản học sinh.

```sh
npm test
```

## Dữ liệu

- SQLite mặc định tại `DATA_DIR/app.sqlite`; `DATA_DIR` mặc định là `.local-data`.
- Ảnh và tệp nằm trong `images/`, `attachments/` cùng thư mục dữ liệu. Sao lưu cả database và các tệp.
- Lớp SQL hiện giữ từng bản ghi với payload JSON và có SQL views; chưa chuẩn hóa mọi cấu trúc lồng nhau.
- Thư mục JSON cũ cần chuyển bằng công cụ offline. Xem [hướng dẫn di chuyển và deploy](README-DEPLOY.md).
- Không commit dữ liệu cá nhân, database, bản sao lưu, `.env` hoặc khóa truy cập.

## Triển khai

Đã có `Dockerfile`, `render.yaml` và Docker Compose. Phương án ưu tiên: **Render Web Service trả phí + Persistent Disk**, một instance, HTTPS do Render cấp. Đọc [README-DEPLOY.md](README-DEPLOY.md) trước khi triển khai và nhập dữ liệu.

Container image chưa được build kiểm chứng trong phiên phát triển này. Repository không kèm database hoặc thông tin đăng nhập thật.

## Giới hạn

- Zalo đang mô phỏng/sao chép thủ công, chưa gửi OA thật.
- Nhập PDF ưu tiên PDF có lớp văn bản; OCR và các dạng đề phức tạp cần phát triển thêm.
- SQLite hiện chạy một instance; nhiều server ghi đồng thời cần PostgreSQL và lưu trữ tệp dùng chung.

## Làm việc với agent

Tuân thủ [AGENTS.md](AGENTS.md). Codex điều phối, Cursor Composer 2.5 ghi mã ứng dụng trong worktree riêng. Không tự commit/push khi chưa được người dùng yêu cầu.
