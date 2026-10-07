# Gemini review pasted for PR #645 (2026-09-28T02:33Z)

đây là review của Gemini cho PR 645 nè:



<pasted_content id="dd76">
## Spec

* **Yêu cầu (Scope):** Hiển thị danh sách Vaults thực tế từ API lên trang chủ thay vì dùng mock data.
* **Lỗi Logic nghiêm trọng (Mock Data Leak):** Tại `vault-card.ts`, dev lấy giá Token từ API thông qua `priceUsd` nhưng lại nhân nó với hằng số hardcode `const UNFUNDED_BALANCE = '0.00'`. Hàm `Number('0.00') * priceUsd` luôn luôn trả về 0. Ứng dụng lãng phí tài nguyên gọi API giá token nhưng UI luôn hiển thị số dư Fiat là `$0`. Đây là code rác chưa dọn sạch trước khi tạo PR.

## Standards

* **Web3 Anti-pattern / Precision Loss (Lỗi nghiêm trọng):**
Tại `vault-card.ts` (dòng 37): `Number(UNFUNDED_BALANCE) * priceUsd`. Việc dùng ép kiểu `Number()` của JavaScript thuần để nhân chia giá trị tiền tệ Web3/Crypto sẽ dẫn đến lỗi sai số dấu phẩy động (Floating-point precision loss). Phải sử dụng các thư viện an toàn như `bignumber.js`, `decimal.js` hoặc `BigInt` của môi trường.
* **AI-Slop / Khủng hoảng State Management:**
Code tạo ra tới 4 custom hooks (`use-space-balance.ts`, `use-space-vaults.ts`, `use-token-prices-usd.ts`) chỉ để fetch data bằng `useEffect`.
* Handle race-condition một cách thủ công, chắp vá (`let cancelled = false`, `requestSeq.current`) thay vì dùng `AbortController`.
* Nuốt lỗi (Swallow errors): Các khối `catch` chỉ văng ra `console.error` và hoàn toàn không cập nhật Error State lên UI. Trong Web3, RPC lỗi hoặc API rớt là chuyện thường ngày; nuốt lỗi sẽ làm app treo loading vĩnh viễn hoặc giấu nhẹm trạng thái mất kết nối của người dùng. Bắt buộc phải dùng công cụ quản lý state chuyên nghiệp (như TanStack Query / SWR) cho các tác vụ I/O này.


* **Shotgun Surgery / Nút thắt cổ chai Network:**
Trang `SharedHomePage` gọi cùng lúc hàng loạt hooks fetch data độc lập. Trong đó `useTokenPricesUsd` chạy `Promise.all` map qua từng symbol. Nếu danh sách Vaults dài, nó sẽ spam RPC nodes/API, dễ bị rate-limit. Cần có cơ chế batching hoặc xử lý gộp ngay từ Backend API.

**Tổng kết:** Có 1 lỗi Spec nghiêm trọng (hiển thị sai số dư) và 3 lỗi Standards (sai số thập phân, quản lý side-effect kém). Lỗi tồi tệ nhất ở Spec là nhân giá Token với hằng số 0, ở Standards là tự build luồng fetch data bằng `useEffect` gây nuốt lỗi âm thầm. Đề xuất: Yêu cầu đập đi làm lại luồng Data Fetching bằng React Query và xóa code tính toán mock.
</pasted_content id="dd76">

