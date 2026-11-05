# Bài thi online — Giai đoạn 1 (PDF kỹ thuật số)

## Phạm vi đã làm

- Nhập PDF kỹ thuật số qua luồng đính kèm giáo viên (20 MB), quét bằng `pdfjs-dist` 6.5.438 (`getDocument` + `getTextContent`).
- PDF quét không có chữ → `needsOcr: true`, chặn xuất bản (OCR/AI để giai đoạn sau).
- Bản nháp, xuất bản phiên bản cố định, giao lớp, học sinh làm bài / lưu / nộp / chấm điểm cục bộ.
- API và UI tiếng Việt; không lộ khóa/ PDF gốc cho học sinh trước khi chính sách cho phép.
- Thư viện PDF phục vụ qua `/vendor/pdfjs/pdf.mjs` và `/vendor/pdfjs/pdf.worker.mjs` (không mở toàn bộ `node_modules`).

## Giới hạn (cố ý)

- Không OCR, không AI, không tạo đáp án tự động.
- Xem PDF trong trình soạn: dự kiến PDF.js (bbox); MVP hiện tập trung soạn câu + khóa sau quét.
- Không chấm lại im lặng khi sửa khóa bản đã xuất bản (sửa → phiên bản mới).

## Chạy kiểm tra

```bash
npm test
```

Bộ mới: `tests/exam-domain.test.mjs`, `tests/exam-e2e.test.mjs` (fixture PDF nội bộ, không tải PDF từ mạng).
