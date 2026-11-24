# نشر دار الهندسة — Vercel + Render + Supabase

هذا المستند هو دليل تنفيذ ربط الأجزاء الموجودة بالفعل. لا ينشئ قاعدة بيانات جديدة،
ولا يلمس قاعدة Production، ولا يعيد بناء الموقع.

## المعمارية المستهدفة

```
المتصفح
   │  https://dar-al-handasa-preview.vercel.app
   ▼
Vercel (Angular SPA)
   │  rewrite: /api/*  →  https://dar-al-handasa-api-staging.onrender.com/api/*
   ▼
Render Web Service (server.mjs)  ── Service Role Key يبقى هنا فقط
   ▼
Supabase Staging (bmmrjbyxmzwrohuprrwa)
```

الواجهة تتصل دائمًا بـ `/api` نسبيًا (same-origin)، وVercel هو الذي يوجّه الطلب إلى
Render. بهذا:

- لا نحتاج كشف عنوان الـ API داخل كود الواجهة.
- لا نحتاج CORS مفتوحًا (الطلب يبدو same-origin للمتصفح).
- لا يوضع Service Role Key في Vercel ولا في المتصفح.

## الملفات التي تم تجهيزها

| الملف | الدور |
|---|---|
| `render.yaml` | Blueprint ينشئ خدمة Staging بإعدادات صحيحة (health check، worker معطّل، فرع Backup). |
| `vercel.json` | يوجّه `/api/*` إلى Render قبل SPA fallback، ويمنع تخزين ردود الـ API. |
| `server.mjs` | يدعم `PORT` و`0.0.0.0`، ويرفض تشغيل Staging ببيانات Production. |

## الخطوة 1 — إنشاء خدمة Render (Staging)

الطريقة الأسرع: Render Dashboard → **New** → **Blueprint** → اختر المستودع
`AdhamHelaly/Dar-AlHandasa` → الفرع `backup/final-codex-state-2026-11-21`.

سيقرأ Render ملف `render.yaml` وينشئ خدمة:

- الاسم: `dar-al-handasa-api-staging`
- Runtime: Node
- Build: `npm ci --omit=dev`
- Start: `npm run start:api:staging`
- Health Check: `/api/health`
- Auto Deploy: **معطّل** (النشر يدوي لتجنّب نشر غير مراجَع)

لو فضّلت الإنشاء اليدوي، استخدم نفس القيم أعلاه حرفيًا.

### متغيرات البيئة على Render

| المتغير | القيمة |
|---|---|
| `APP_ENV` | `staging` |
| `NODE_ENV` | `production` |
| `IS_CLOUD_DEPLOYMENT` | `true` |
| `API_HOST` | `0.0.0.0` |
| `WHATSAPP_RESERVATION_WORKER_ENABLED` | `false` |
| `STAGING_SUPABASE_PROJECT_REF` | `bmmrjbyxmzwrohuprrwa` |
| `FRONTEND_ORIGIN` | `https://dar-al-handasa-preview.vercel.app` |
| `SUPABASE_URL` | `https://bmmrjbyxmzwrohuprrwa.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | من `.env.staging` — يُلصق في لوحة Render فقط |
| `SESSION_SECRET` | من `.env.staging` (32 حرفًا على الأقل) |
| `ADMIN_EMAIL` | من `.env.staging` |
| `ADMIN_PASSWORD` | من `.env.staging` |

> لا تضع قيم الأسرار في Git أو في هذا الملف أو في أي لقطة شاشة. القيم موجودة عندك في
> `.env.staging` على `A:\DarAlhandsa` فقط.

`server.mjs` يرفض الإقلاع إذا:

- كان `APP_ENV=staging` لكن مشروع Supabase ليس `bmmrjbyxmzwrohuprrwa`.
- كانت بيانات الأدمن أو المفاتيح ما زالت Placeholder.
- حاولت تشغيل Worker خارج Staging/Production.

## الخطوة 2 — التحقق من الـ Backend مباشرة

بعد أول Deploy، افتح:

```
https://dar-al-handasa-api-staging.onrender.com/api/health
```

الرد المتوقع:

```json
{
  "status": "ok",
  "database": "supabase",
  "environment": "staging",
  "supabaseProjectRef": "bmmrjbyxmzwrohuprrwa",
  "reservationWorker": { "enabled": false }
}
```

ثم:

```
https://dar-al-handasa-api-staging.onrender.com/api/products
```

يجب أن يعيد `{ "products": [...] }` بمنتجات Staging (منها المنتج التجريبي
`STAGE-20261121-672B643111`).

> الخطة المجانية في Render تُوقف الخدمة عند عدم الاستخدام. أول طلب بعد الخمول قد
> يستغرق 30–60 ثانية. هذا سلوك متوقع، وليس عطلًا.

## الخطوة 3 — ربط Vercel بالـ Backend

`vercel.json` يحتوي بالفعل على:

```json
{ "source": "/api/:path*",
  "destination": "https://dar-al-handasa-api-staging.onrender.com/api/:path*" }
```

لو أعطاك Render اسمًا مختلفًا (يحدث فقط إذا كان الاسم محجوزًا عالميًا)، عدّل
`destination` في `vercel.json` إلى العنوان الفعلي، ثم أعد النشر:

```powershell
cd A:\DarAlhandsa
vercel deploy
vercel ls dar-al-handasa-preview
```

اضبط النطاق الثابت `dar-al-handasa-preview.vercel.app` على هذا النشر (Promote)، لأن
الـ Backend يقبل أصلًا واحدًا فقط (`FRONTEND_ORIGIN`). روابط المعاينة العشوائية
(`...-abc123.vercel.app`) سترجع `403 origin_not_allowed`.

## الخطوة 4 — اختبار نهائي من الموقع المنشور

افتح `https://dar-al-handasa-preview.vercel.app` وتأكد من:

- [ ] ظهور المنتجات (وليس رسالة فشل تحميل الكتالوج).
- [ ] البحث والفلترة بالماركة والتصنيف والسعر.
- [ ] صفحة تفاصيل المنتج والسلة.
- [ ] Checkout مع حساب السعر من الخادم.
- [ ] تسجيل دخول الأدمن وفتح لوحة التحكم.
- [ ] رفع صورة منتج واستبدالها وحذفها (من خلال الـ Backend).
- [ ] إدارة الطلبات والمخزون.
- [ ] `/api/health` عبر نطاق Vercel يعيد نفس نتيجة Render.

أوامر فحص سريعة:

```powershell
Invoke-RestMethod https://dar-al-handasa-preview.vercel.app/api/health
(Invoke-RestMethod https://dar-al-handasa-preview.vercel.app/api/products).products.Count
```

## الخطوة 5 — Production (بعد موافقة صريحة فقط)

لا تنفّذ هذه الخطوة قبل نجاح Staging بالكامل وموافقة صاحب المشروع:

1. أنشئ خدمة Render منفصلة (أو Blueprint منفصل) بقيم Production.
2. `SUPABASE_URL` = `https://ipegazjnkejasorskdur.supabase.co` و
   `APP_ENV=production` (بدون `STAGING_SUPABASE_PROJECT_REF`).
3. `FRONTEND_ORIGIN` = النطاق النهائي.
4. غيّر `destination` في `vercel.json` إلى عنوان Backend الإنتاجي.
5. اختبر Health Check ثم كل الوظائف، ثم اعتمد النشر.

## استكشاف الأخطاء

| العرض | السبب المرجّح | الحل |
|---|---|---|
| `503 supabase_not_configured` | `SUPABASE_URL` أو المفتاح غير مضبوط | راجع متغيرات Render |
| `Invalid staging configuration` | المشروع ليس Staging، أو قيمة Placeholder | صحّح `STAGING_SUPABASE_PROJECT_REF` والبيانات |
| `403 origin_not_allowed` | الأصل ليس `FRONTEND_ORIGIN` بالحرف | افتح عبر النطاق الثابت أو حدّث القيمة |
| `502` من Vercel على `/api/*` | Render متوقف/اسم الخدمة مختلف | افتح `/api/health` على Render وعدّل `destination` |
| المنتجات تظهر بعد تأخير | Cold Start للخطة المجانية | ترقية الخطة أو إبقاء الخدمة دافئة |
| فشل Health Check أثناء النشر | المتغيرات لم تُضبط قبل أول Deploy | أضفها ثم Manual Deploy |

## الرجوع للخلف

- إعادة نشر نسخة Vercel سابقة من لوحة Vercel (Deployments → Promote).
- تعطيل الخدمة على Render لا يؤثر على Supabase.
- لا حذف لأي طلب أو منتج؛ الأرشفة فقط.
