# نشر دار الهندسة على Vercel (واجهة + API)

كل شيء يعمل على مشروع Vercel واحد. لا يوجد Render، ولا قاعدة بيانات جديدة. الواجهة
والـ API متصلان الآن بقاعدة **Production** الحالية (`ipegazjnkejasorskdur`)، وهي قاعدة
البيانات الوحيدة المستخدمة في النشر.

## المعمارية

```
المتصفح
   │  https://dar-al-handasa-preview.vercel.app
   ▼
Vercel
   ├── /            → Angular static build (dist/dar-al-handasa/browser)
   └── /api/*       → Serverless Function: api/[...path].mjs
                         └── server.mjs  (نفس الراوتر المستخدم محليًا)
   ▼
Supabase Production (ipegazjnkejasorskdur)
```

- الواجهة تستدعي `/api` نسبيًا، فالمتصفح يرى نفس الأصل (لا CORS مفتوح).
- `SUPABASE_SERVICE_ROLE_KEY` موجود في Vercel Environment Variables ويُقرأ داخل
  الـ Function فقط، ولا يصل للمتصفح.
- `server.mjs` ما زال يعمل كسيرفر عادي محليًا (`npm run start:api`)؛ عند وجود
  `VERCEL=1` لا يستدعي `listen` ويُصدّر `requestHandler` للـ Function.

## الملفات

| الملف | الدور |
|---|---|
| `api/[...path].mjs` | Catch-all Function توجّه كل `/api/*` إلى `requestHandler`. |
| `server.mjs` | الراوتر والمنطق كما هو، مع تصدير المعالج ومنع `listen` على Vercel. |
| `vercel.json` | بناء Angular، إعادة كتابة `/api/:path*` إلى الـ Function، SPA fallback، `no-store`، ومدة 30 ثانية. |
| `.vercelignore` | يمنع رفع `node_modules` و`.env*` و`dist` إلى Vercel. |

### ملاحظات على `vercel.json` (مهمة لأي تعديل مستقبلي)

1. **`/api/:path*` → `/api/[...path]` إلزامية.** في Vercel، ملف `[...path].mjs` كـ Function عادية
   يطابق **مقطعًا واحدًا فقط**؛ بدون هذه القاعدة ترجع المسارات المتداخلة مثل
   `/api/admin/products` خطأ 404 من المنصة ولا تصل للكود إطلاقًا.
2. **SPA fallback وجهته `/` وليس `/index.html`.** مع `cleanUrls: true` لا تعمل وجهة
   `/index.html`، لذلك نستخدم `/` مع بقاء عنوان المتصفح كما هو.
3. ترتيب القواعد مهم: قاعدة API أولًا، ثم fallback.
4. الملفات الثابتة والـ Function تُخدَم قبل قواعد الـ rewrite، لذلك الصور و`main-*.js`
   لا تتأثر بالـ fallback.

## متغيرات البيئة المطلوبة في Vercel

تُضاف على مستوى المشروع (Production + Preview). كلها Server-side ولا تظهر في الحزمة.

| المتغير | القيمة |
|---|---|
| `APP_ENV` | `production` |
| `IS_CLOUD_DEPLOYMENT` | `true` |
| `WHATSAPP_RESERVATION_WORKER_ENABLED` | `false` |
| `SUPABASE_URL` | `https://ipegazjnkejasorskdur.supabase.co` |
| `FRONTEND_ORIGIN` | `https://dar-al-handasa-preview.vercel.app` |
| `PRODUCT_IMAGE_MAX_BYTES` | `4000000` |
| `SUPABASE_SERVICE_ROLE_KEY` | مفتاح Production (Secret) |
| `SESSION_SECRET` | سر عشوائي 96 حرفًا (Secret) |
| `ADMIN_EMAIL` | بريد مدير المتجر |
| `ADMIN_PASSWORD` | كلمة مرور المدير (Secret) |

`NODE_ENV=production` يضبطه Vercel تلقائيًا. لا حاجة لـ `API_PORT` أو `API_HOST`.

## حدود Vercel التي يجب مراعاتها

- **حجم الطلب 4.5MB** على الخطة المجانية، لذلك `PRODUCT_IMAGE_MAX_BYTES=4000000`
  حتى يرفض الخادم الصور الكبيرة برسالة `413` واضحة بدل فشل الطلب كله.
- **مدة التنفيذ** 30 ثانية (مضبوطة في `vercel.json`). الاستعلامات العادية أسرع بكثير.
- كل Function لها **Cold Start** قصير عند أول طلب بعد خمول.
- لا يوجد Worker دائم؛ `WHATSAPP_RESERVATION_WORKER_ENABLED=false` إلزامي.
  إن احتجنا جدولة لاحقًا فالحل Vercel Cron يستدعي مسارًا مخصصًا، وليس مؤقتًا داخليًا.

## النشر

```powershell
cd A:\DarAlhandsa
npm run build -- --configuration production   # تحقق محلي
vercel deploy                                  # معاينة
vercel ls dar-al-handasa-preview
```

بعد نجاح المعاينة، ثبّت النشر على النطاق:

```powershell
vercel promote <deployment-url>
```

## التحقق

```powershell
Invoke-RestMethod https://dar-al-handasa-preview.vercel.app/api/health
(Invoke-RestMethod https://dar-al-handasa-preview.vercel.app/api/products).products.Count
```

الرد المتوقع من `/api/health`:

```json
{ "status": "ok", "database": "supabase", "environment": "production",
  "reservationWorker": { "enabled": false } }
```

## استكشاف الأخطاء

| العرض | السبب | الحل |
|---|---|---|
| `FUNCTION_INVOCATION_FAILED` | خطأ أثناء تحميل الوحدة (بيانات ناقصة) | راجع Logs في Vercel (رسالة مثل `Invalid staging configuration` أو `supabase_not_configured`) |
| `403 origin_not_allowed` | الطلب من رابط معاينة عشوائي | استخدم النطاق الثابت أو حدّث `FRONTEND_ORIGIN` |
| `503 supabase_not_configured` | متغيرات Supabase ناقصة | أضفها ثم أعد النشر |
| `413 image_too_large` | الصورة أكبر من 4MB | صغّر الصورة (حد Vercel) |
| المنتجات تظهر بعد تأخير بسيط | Cold Start | طبيعي على الخطة المجانية |

## بيئة Staging المحلية (اختيارية)

قاعدة Staging (`bmmrjbyxmzwrohuprrwa`) لم تعد مستخدمة في النشر. تبقى فقط للاختبارات
المحلية المعزولة عبر `.env.staging` والمنفذ `3203`، ولا تُوجَّه أي كتابة إلى Production.

قبل أي اختبار كتابة على Staging:

1. شغّل الـ API على `127.0.0.1:3203` مع `--env=staging`.
2. تأكد أن `/api/health` يعرض `environment=staging` و`supabaseProjectRef=bmmrjbyxmzwrohuprrwa`.
3. لا تختبر الكتابة (Checkout / رفع صور) على النطاق المنشور لأنه متصل بـ Production.

## قاعدة Production

- المشروع: `ipegazjnkejasorskdur`.
- المفتاح المستخدم من نوع `sb_secret_...` ويُرسَل من الـ Function فقط (Node fetch).
- لا تُنشئ سجلات اختبار على Production، ولا تحذف أي بيانات أعمال؛ الأرشفة فقط.
- أي عملية كتابة على Production تتم بموافقة صريحة فقط.
