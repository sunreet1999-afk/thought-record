# AI backend setup (mobile se)

Ek baar karna hai. Sab browser se ho jaata hai, laptop nahi chahiye.

## 1. Anthropic key
1. console.anthropic.com → **API Keys** → Create Key. Key copy karo.
2. Wahin **Limits** mein monthly spend limit set karo (jaise $5).

## 2. Supabase secrets
Supabase Dashboard → project → **Edge Functions → Secrets** (`supabase.com/dashboard/project/_/functions/secrets`). Do secrets add karo:

| Name | Value |
|---|---|
| `ANTHROPIC_API_KEY` | Step 1 wali key |
| `ALLOWED_USER_ID` | Authentication → Users mein aapke account ka **UID** |

Key kahin aur mat daalna: na GitHub mein, na code mein, na chat mein.

## 3. Deploy token (GitHub ke liye)
1. supabase.com/dashboard/account/tokens → **Generate new token** → copy.
2. GitHub → repo `thought-record` → **Settings → Secrets and variables → Actions → New repository secret**
   - Name: `SUPABASE_ACCESS_TOKEN`
   - Value: wahi token

## 4. Deploy
GitHub → repo → **Actions → Deploy AI function → Run workflow** → branch chuno → Run.
`main` pe merge hone ke baad `supabase/functions/` badalne pe ye khud chalega.

## 5. Check
Browser mein kholo: `https://gxlgnqtbmytwjoisrsjf.supabase.co/functions/v1/ai`
Jawab `{"error":"unauthorized"}` aana chahiye. Iska matlab function chal raha hai aur bina login ke kisi ko jawab nahi deta.
Agar `{"error":"not_configured"}` aaye to step 2 ka koi secret missing hai.

## Kya log hota hai
Har request pe sirf ek line: mode, status code aur kitne ms lage. Entry, tags, sawaal ya AI ka jawab kabhi log nahi hota.
