"use strict";

(() => {
  const en = {
    pageTitle: "Peetty — cute anime characters for your web pages",
    pageDescription: "Add a cute anime character to your web page. Watch her walk, jump and nap on page elements, or create a character of your own.",
    tryPlaceholder: "Say something…",
    tryAria: "Try typing",
    starLabel: "Star Peetty on GitHub (opens in a new tab)",
  };
  for (const node of document.querySelectorAll("[data-i18n]")) en[node.dataset.i18n] = node.textContent;
  for (const node of document.querySelectorAll("[data-i18n-html]")) en[node.dataset.i18nHtml] = node.innerHTML;

  IdySite.init({
    en,
    zh: {
      pageTitle: "Peetty — 跑到网页上的可爱二次元女孩",
      pageDescription: "让可爱的二次元女孩住进你的网页。看她在页面元素上散步、跳跃、打盹，也可以创建自己的角色。",
      navMeet: "角色", navEmbed: "加到网页", starLabel: "在 GitHub 上给 Peetty 点星（在新标签页打开）",
      heroTitle: "可爱的二次元女孩，<br>跑到网页上啦。",
      heroDescription: "选一个你喜欢的二次元女孩，让她在你的网页上动起来。她会沿着卡片散步，在按钮之间跳来跳去，挥挥手，再找个地方打个盹。",
      chatWithHer: "和她聊聊", addToPage: "加到你的网页", viewSource: "查看源代码",
      heroNote: "她现在就在这个页面上。双击聊天，右键打开菜单，也可以拖起她。第一次聊天时，填入自己的 API 地址和 key，再选一个模型。",
      playgroundTitle: "可以落脚的地方",
      tileReadingLabel: "阅读", tileReading: "一篇长文，一个安静的下午。",
      tileNotesLabel: "笔记", tileNotes: "三个值得留下的想法。",
      tileMusicLabel: "音乐", tileMusic: "放点轻柔的背景音乐。",
      tryLabel: "在这里打字试试，她会让开。", tryPlaceholder: "说点什么…", tryAria: "试着打字",
      meetTitle: "六个原创角色。",
      meetIntro: "每个角色都有自己的样子和节奏。在这里切换，你的选择会记在本网站上。",
      miruText: "薰衣草色双马尾，鼠标指针发夹。轻快活泼，你靠近时会挥手。",
      koharuText: "来自日本，蜜桃色短发，猫耳贝雷帽。懒洋洋的，常打盹，醒来伸个懒腰。",
      xiaoxiaoText: "来自中国，黑色双丸子头系红绳。机灵爱笑，手边总有一杯奶茶。",
      rileyText: "来自美国，栗色高马尾，棒球夹克。阳光外向，跳得最高，爱吹泡泡糖。",
      amaraText: "来自美国，两个卷卷的丸子头，带着相机。好奇心满满，看到喜欢的就拍下来。",
      elsieText: "来自英国，蜂蜜金短发，脸上有小雀斑。安静有礼，爱喝茶，掉下来时撑伞慢慢飘落。",
      featuresTitle: "让网页多一点，<br>可可爱爱。",
      featuresIntro: "动作都在页面本地运行。她走路、跳跃、眨眼，都不需要向任何地方发送数据。",
      edgesTitle: "在页面上安家。",
      edgesDescription: "她站在卡片、图片和按钮看得见的顶边上，随页面滚动跟着走；边缘消失时，就掉到下面一处。",
      clearTitle: "不挡你的路。",
      clearDescription: "边缘上方的文字和控件不会被遮住。没在用的输入框她可以坐一坐，你一点进去她就跳开，打字时她也会安静下来。",
      figuresTitle: "做你自己的角色。",
      figuresDescription: "角色是一个 JSON 形象包：挂在标准骨架上的分层矢量部件、调色板和表情。SDK 能让任何形象动起来，改调色板就能换配色。",
      chatTitle: "聊聊天，挥挥手。",
      chatDescription: "连接 OpenAI 兼容接口，选好模型，就可以和她聊天。她会回应你的话，也能挥手、坐下或打个盹。连接和对话记录保存在这个浏览器里。",
      unavailable: "暂不可用",
      embedTitle: "一行脚本。",
      embedIntro: "通过 jsDelivr 公共 CDN 直接加载，不用 npm 安装，也不用构建。用 data-peetty=\"perch\" 标出推荐落脚点，用 data-peetty=\"avoid\" 让她远离某块区域。",
      embedOptions: "可选属性：data-figure（角色 id，如 miru、amara，或形象 JSON 的地址）、data-size（高度像素）、data-activity（calm、normal、lively）、data-language（en、zh）、data-greet=\"false\"。",
      moduleNote: "需要用 JavaScript 控制时，直接在浏览器模块中 import。样式和依赖已内置，无需额外安装。",
      questionsTitle: "一些说明。",
      dataQuestion: "她会把我页面上的内容发出去吗？",
      dataAnswer: "寻找落脚点和播放动画都在浏览器本地完成，不会为这些动作发送网页内容。",
      motionQuestion: "系统开了“减少动态效果”怎么办？",
      motionAnswer: "系统要求减少动态效果时，她不再走动和跳跃，多数时候坐在原地。你仍然可以拖动她。",
      hideQuestion: "怎么让她先离开？",
      hideAnswer: "把鼠标停在她身上，选“先藏起来”。在你自己的网页上，可以调用 pet.hide() 或 pet.destroy()。",
      licenseQuestion: "可以使用这些角色吗？",
      licenseAnswer: "代码使用 MIT 许可。Peetty 的角色都是原创，采用 CC BY 4.0 许可，注明出处即可使用和改编。",
      figureDocs: "形象包格式",
    },
  });
})();
