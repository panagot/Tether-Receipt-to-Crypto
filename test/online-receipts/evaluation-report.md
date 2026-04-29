# Online Receipts Batch Evaluation

- API base: `http://127.0.0.1:3847`
- Samples: 10
- Accurate (total+currency): 3
- Partial (missing expected): 2
- Failed: 5
- Success HTTP responses: 10

| file | status | merchant | extracted total | extracted currency | expected total | expected currency | pass/fail | notes |
|---|---|---|---:|---|---:|---|---|---|
| sroie-001.jpg | ok | Indah GiFT & HOME Deco | 10 | MYR | 60.3 | MYR | fail | Ground truth from SROIE key labels.; Total mismatch. |
| sroie-002.jpg | ok | Tan Woon Yann | 50 | MYR | 33.9 | MYR | fail | Ground truth from SROIE key labels.; Total mismatch. |
| sroie-003.jpg | ok | YONGFATT ENTERPRISE | 80.91 | MYR | 80.9 | MYR | pass | Ground truth from SROIE key labels. |
| sroie-004.jpg | ok | Tan Woon Yann | 30.91 | MYR | 30.9 | MYR | pass | Ground truth from SROIE key labels. |
| sroie-005.jpg | ok | ABC HO TRADING | 15.5 | MYR | 31 | MYR | fail | Ground truth from SROIE key labels.; Total mismatch. |
| sroie-006.jpg | ok | SOON HUAT MACHINERY ENTERPRISE | 327 | MYR | 327 | MYR | pass | Ground truth from SROIE key labels. |
| sroie-007.jpg | ok | Tan Chay Yee HOLOH | 0.2 | MYR | 20 | MYR | fail | Ground truth from SROIE key labels.; Total mismatch. |
| sroie-008.jpg | ok | GOGIANT ENGINEERING (M) SDN BHD | 6.37 | MYR | 112.45 | MYR | fail | Ground truth from SROIE key labels.; Total mismatch. |
| invoice-barlow.png | ok | Bertram Gilfoyle | 0.2 | MYR |  |  | partial | No machine-readable ground-truth label found; best-effort visual comparison only.; Expected total/currency unavailable, marked as partial. |
| invoice-sarabun.png | ok | Bank For Your Buck | 0.2 | MYR |  |  | partial | No machine-readable ground-truth label found; best-effort visual comparison only.; Expected total/currency unavailable, marked as partial. |
