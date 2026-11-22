# מערכת השוואת מחירי שוק בזמן אמת — סניף הרצליה (MVP)

מערכת מהירה למוכרים להשוואת מחירי **DJI ישראל** ו-**בנדא סטור** מול מתחרים מאושרים (יבואן רשמי, מחירי מרכז כולל מע"מ), עם סריקת ברקודים במצלמה ו-Price Match Guard.

## הפעלה מהירה ב-GitHub (3 דקות)
1. צור מאגר חדש ב-GitHub (למשל `price-match-il`) והעלה אליו את כל הקבצים מתיקייה זו.
2. כנס ל-**Settings → Pages**:
   - תחת **Source** בחר `Deploy from a branch`.
   - תחת **Branch** בחר `main` ותיקיית `/docs`, ולחץ **Save**.
3. כנס ללשונית **Actions → Daily Market Price Sync → Run workflow**:
   - בפעם הראשונה השאר `mode = dji` להרצה מהירה ובדיקת דיוק.
   - לאחר שהריצה מסתיימת בהצלחה, פתח את כתובת ה-GitHub Pages שלך (ב-HTTPS) בטאבלט או בנייד.
4. כדי להרחיב לכל הקטלוג של בנדא סטור, הרץ שוב עם `mode = full`.

## הרצת בדיקות מקומית (אופציונלי)
```bash
pip install -r requirements.txt
pytest -v
python run_sync.py --demo
```
