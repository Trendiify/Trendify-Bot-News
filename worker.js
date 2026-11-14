export default {
  async scheduled(event, env, ctx) {
    // گرفتن ساعت کنونی به وقت تهران
    const tehranTime = new Date().toLocaleTimeString('en-US', {
      timeZone: 'Asia/Tehran',
      hour12: false,
      hour: '2-digit'
    });

    const currentHour = parseInt(tehranTime, 10);

    // فقط اگر ساعت ۱۲ ظهر یا ۲۱ شب (۹ شب) بود پست بفرست
    if (currentHour === 12 || currentHour === 21) {
      ctx.waitUntil(runAutoAdmin(env));
    }
  },

  async fetch(request, env, ctx) {
    await runAutoAdmin(env); // تغییر event به env
    return new Response("ارسال دستی انجام شد! 🚀");
  }
};

async function runAutoAdmin(env) {
  try {
    const feeds = [
      {
        category: "هوش مصنوعی",
        emoji: "🤖",
        hashtag: "#هوش_مصنوعی #AI #تکنولوژی",
        url: "https://www.zoomit.ir/feed/",
        defaultImg: "https://images.unsplash.com/photo-1677442136019-21780efad99a?w=800"
      },
      {
        category: "بازی و گیمینگ",
        emoji: "🎮",
        hashtag: "#گیمینگ #بازی #Game",
        url: "https://www.zoomg.ir/feed/",
        defaultImg: "https://images.unsplash.com/photo-1538481199705-c710c4e965fc?w=800"
      },
      {
        category: "ارز دیجیتال",
        emoji: "🪙",
        hashtag: "#کریپتو #ارز_دیجیتال #بیت_کوین",
        url: "https://arzdigital.com/feed/",
        defaultImg: "https://images.unsplash.com/photo-1621416894569-0f39ed31d247?w=800"
      }
    ];

    const selectedFeed = feeds[Math.floor(Math.random() * feeds.length)];
    const rssResponse = await fetch(selectedFeed.url);
    const xmlText = await rssResponse.text();

    const items = xmlText.match(/<item>([\s\S]*?)<\/item>/g) || [];

    for (const itemContent of items) {
      // استخراج تایتل و لینک برای چک کردن تکراری نبودن
      const linkMatch = itemContent.match(/<link>(.*?)<\/link>/);
      const newsLink = linkMatch ? linkMatch[1].replace(/<!\[CDATA\[(.*?)\]\]>/g, '$1').trim() : '';

      // ۴. بررسی عدم تکرار (Memory Log با KV)
      if (env.NEWS_KV && newsLink) {
        const isSent = await env.NEWS_KV.get(newsLink);
        if (isSent) continue; // اگر قبلاً ارسال شده بود، خبر بعدی را بررسی کن
      }

      // استخراج اطلاعات خبر
      const titleMatch = itemContent.match(/<title>(.*?)<\/title>/);
      const descMatch = itemContent.match(/<description>([\s\S]*?)<\/description>/);
      
      const imgMatch = itemContent.match(/<media:content[^>]+url=["'](.*?)["']/i) || 
                       itemContent.match(/<img[^>]+src=["'](.*?)["']/i) ||
                       itemContent.match(/url=["'](https?:\/\/[^"']+\.(?:png|jpg|jpeg|webp))["']/i);
      
      const videoMatch = itemContent.match(/<media:content[^>]+type=["']video\/[^"']+["'][^>]+url=["'](.*?)["']/i) ||
                         itemContent.match(/href=["'](https?:\/\/[^"']+\.(?:mp4|mkv))["']/i);

      const rawTitle = titleMatch ? titleMatch[1].replace(/<!\[CDATA\[(.*?)\]\]>/g, '$1').trim() : '';
      const rawDesc = descMatch ? descMatch[1].replace(/<[^>]+>/g, '').replace(/<!\[CDATA\[(.*?)\]\]>/g, '$1').trim() : '';
      const imageUrl = imgMatch ? imgMatch[1] : selectedFeed.defaultImg;
      const videoUrl = videoMatch ? videoMatch[1] : null;

      // خلاصه‌سازی شکیل با AI
      let formattedCaption = "";
      const prompt = `تو ادیتور ارشد یک کانال تلگرامی لوکس هستی.
این خبر را به یک پست تلگرامی بسیار شکیل و خوانا تبدیل کن.
قواعد:
- تیتر جذاب و بولد
- ۲ تا ۳ نکته کلیدی با بولت‌پوینت و ایموجی
- لحن حرفه‌ای و جذاب
خبر: ${rawTitle}\n${rawDesc.slice(0, 400)}`;

      if (env.AI) {
        const aiResponse = await env.AI.run('@cf/meta/llama-3-8b-instruct', {
          messages: [
            { role: 'system', content: prompt },
            { role: 'user', content: rawTitle }
          ]
        });
        const aiText = aiResponse.response.trim();
        formattedCaption = `${selectedFeed.emoji} **${selectedFeed.category}**\n` +
                           `───────────\n` +
                           `${aiText}\n` +
                           `───────────\n` +
                           `${selectedFeed.hashtag}`;
      } else {
        formattedCaption = `${selectedFeed.emoji} **${rawTitle}**\n\n` +
                           `🔹 ${rawDesc.slice(0, 200)}...\n\n` +
                           `───────────\n` +
                           `${selectedFeed.hashtag}`;
      }

      // ارسال به تلگرام
      if (videoUrl) {
        await sendTelegramMedia(env, "sendVideo", { video: videoUrl, caption: formattedCaption });
      } else {
        await sendTelegramMedia(env, "sendPhoto", { photo: imageUrl, caption: formattedCaption });
      }

      // ثبت در KV تا دفعه بعد تکراری فرستاده نشود
      if (env.NEWS_KV && newsLink) {
        await env.NEWS_KV.put(newsLink, "true", { expirationTtl: 86400 * 7 }); // نگهداری ۷ روزه
      }

      break; // فقط یک خبر ارسال کن و خارج شو
    }

  } catch (error) {
    console.error("خطا در اجرای ادمین خودکار:", error);
  }
}

async function sendTelegramMedia(env, method, payload) {
  const url = `https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`;
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: env.CHANNEL_ID,
      parse_mode: "Markdown",
      ...payload
    })
  });
}
