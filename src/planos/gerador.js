// src/planos/gerador.js
// Gera o HTML completo da proposta com base nos dados da IA

export function gerarHTML(dados) {
  const {
    nomeLead, dataFormatada, s01Intro,
    s02Titulo, s02Conteudo,
    s03Titulo, s03Steps,
    s04Mes1, s04Mes2, s04Mes3,
    nutriNome, nutriRole, nutriBio, nutriFoto,
  } = dados;

  const stepsHTML = s03Steps.map((step, i) => `
    <li class="reveal">
      <div class="step-num-badge">${i + 1}</div>
      <div class="step-content">
        <h3>${step.titulo}</h3>
        <p>${step.descricao}</p>
      </div>
    </li>`).join('');

  const mesHTML = (num, titulo, items, dotClass) => `
    <div class="tl-item reveal">
      <div class="tl-dot ${dotClass}">${num}</div>
      <div class="tl-body">
        <span class="tl-month">Mês ${num}</span>
        <h3>${titulo}</h3>
        <ul>${items.map(item => `<li>${item}</li>`).join('')}</ul>
      </div>
    </div>`;

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Proposta Personalizada — ${nomeLead} · Table Clinic</title>
  <script>
    !function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?
    n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;
    n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;
    t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,
    document,'script','https://connect.facebook.net/en_US/fbevents.js');
    fbq('init','989971718548782');
    fbq('track','PageView');
    fbq('track','ViewContent',{content_name:'Table Elite'});
  </script>
  <noscript><img height="1" width="1" style="display:none" src="https://www.facebook.com/tr?id=989971718548782&ev=PageView&noscript=1"/></noscript>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,300;0,400;0,500;0,600;0,700;1,300;1,400;1,600&family=Jost:wght@300;400;500;600&display=swap" rel="stylesheet" />
  <style>
    :root{--moss:#3D4A35;--moss-mid:#4E5E42;--moss-pale:#E8EDE4;--cream:#F8F4EE;--warm:#EDE5D8;--sand:#D8CCBA;--terra:#B97040;--terra-dk:#8A4F28;--brown:#2C2018;--muted:#7A6E64;--white:#FFFFFF;--line:#DDD4C4}
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
    html{scroll-behavior:smooth}
    body{font-family:'Jost',sans-serif;background:var(--cream);color:var(--brown);font-size:16px;line-height:1.7;overflow-x:hidden}
    .reveal{opacity:0;transform:translateY(28px);transition:opacity .68s ease,transform .68s ease}
    .reveal.visible{opacity:1;transform:translateY(0)}
    .section{position:relative;padding:72px 24px;border-bottom:1px solid var(--line)}
    .section:last-child{border-bottom:none}
    .section-inner{max-width:720px;margin:0 auto}
    .section-num{font-family:'Jost',sans-serif;font-size:11px;font-weight:500;letter-spacing:.18em;color:var(--terra);text-transform:uppercase;margin-bottom:32px;display:block}
    h1,h2,h3{font-family:'Cormorant Garamond',serif;line-height:1.2}
    h2{font-size:clamp(1.9rem,4.5vw,2.7rem);font-weight:400}
    h3{font-size:1.3rem;font-weight:500}
    p{margin-bottom:1.1em;color:var(--brown);font-weight:300}
    p:last-child{margin-bottom:0}
    strong{font-weight:600;color:var(--moss)}
    .divider{width:40px;height:2px;background:var(--terra);margin:24px 0}
    .divider-light{width:40px;height:2px;background:var(--sand);margin:24px 0}
    .s01{background:var(--moss);color:var(--cream);padding-top:56px;padding-bottom:84px}
    .s01 .section-num{color:var(--sand)}
    .s01 p{color:var(--moss-pale)}
    .s01 strong{color:var(--warm)}
    .doc-meta{display:flex;flex-wrap:wrap;gap:8px 20px;align-items:center;margin-bottom:52px}
    .doc-meta span{font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--sand);font-weight:400}
    .badge-conf{background:var(--terra);color:var(--white);font-size:10px;letter-spacing:.16em;font-weight:600;padding:3px 10px;border-radius:2px;text-transform:uppercase}
    .lead-name{font-size:clamp(3rem,9vw,5.6rem);font-family:'Cormorant Garamond',serif;font-weight:300;font-style:italic;color:var(--cream);line-height:1.05;margin-bottom:36px}
    .lead-name em{font-style:normal;color:var(--terra)}
    .intro-text{font-size:1.08rem;color:var(--moss-pale);font-weight:300;max-width:580px;line-height:1.85}
    .s02{background:var(--cream)}
    .insight-block{background:var(--warm);border-left:3px solid var(--terra);padding:24px 28px;border-radius:0 8px 8px 0;margin:32px 0}
    .insight-block p{color:var(--brown);margin:0;font-size:.97rem}
    .s03{background:var(--moss-pale)}
    .steps-list{list-style:none;margin-top:32px}
    .steps-list li{display:grid;grid-template-columns:48px 1fr;gap:0 20px;margin-bottom:28px;align-items:start}
    .step-num-badge{width:48px;height:48px;background:var(--moss);color:var(--cream);border-radius:50%;display:flex;align-items:center;justify-content:center;font-family:'Cormorant Garamond',serif;font-size:1.4rem;font-weight:400;flex-shrink:0;margin-top:2px}
    .step-content h3{font-size:1.04rem;font-family:'Jost',sans-serif;font-weight:600;color:var(--moss);margin-bottom:6px}
    .step-content p{font-size:.93rem;color:var(--muted);margin:0}
    .s04{background:var(--cream)}
    .timeline{margin-top:40px;position:relative}
    .timeline::before{content:'';position:absolute;left:23px;top:0;bottom:0;width:2px;background:var(--line)}
    .tl-item{display:grid;grid-template-columns:48px 1fr;gap:0 24px;margin-bottom:40px;position:relative}
    .tl-dot{width:48px;height:48px;background:var(--terra);border-radius:50%;display:flex;align-items:center;justify-content:center;color:var(--white);font-family:'Cormorant Garamond',serif;font-size:1.2rem;font-weight:600;flex-shrink:0;z-index:1;position:relative}
    .tl-dot.m2{background:var(--moss-mid)}
    .tl-dot.m3{background:var(--moss)}
    .tl-body{padding-top:10px}
    .tl-month{font-size:10px;letter-spacing:.18em;text-transform:uppercase;color:var(--terra);font-weight:600;margin-bottom:4px;display:block}
    .tl-body h3{font-size:1.25rem;color:var(--moss);margin-bottom:10px}
    .tl-body ul{list-style:none;padding:0}
    .tl-body ul li{font-size:.93rem;color:var(--muted);padding:4px 0 4px 18px;position:relative;font-weight:300}
    .tl-body ul li::before{content:'·';position:absolute;left:4px;color:var(--terra);font-size:1.2rem;line-height:1.4}
    .curve-wrap{margin-top:40px;background:var(--warm);border-radius:12px;padding:28px 20px 20px}
    .curve-label{font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--muted);margin-bottom:12px;display:block}
    .curve-svg{width:100%;height:auto}
    .s05{background:var(--moss-pale)}
    .team-grid{display:grid;grid-template-columns:1fr;gap:28px;margin-top:36px}
    @media(min-width:560px){.team-grid{grid-template-columns:1fr 1fr}}
    .team-card{background:var(--white);border-radius:12px;overflow:hidden;box-shadow:0 2px 16px rgba(44,32,24,.06)}
    .team-photo{width:100%;aspect-ratio:4/3;object-fit:cover;object-position:top center;display:block}
    .team-avatar{width:100%;aspect-ratio:4/3;display:none;align-items:center;justify-content:center;background:var(--moss);font-family:'Cormorant Garamond',serif;font-size:4rem;color:var(--cream);font-weight:300}
    .team-info{padding:20px 22px 24px}
    .team-role{font-size:10px;letter-spacing:.18em;text-transform:uppercase;color:var(--terra);font-weight:600;margin-bottom:6px;display:block}
    .team-info h3{font-size:1.3rem;color:var(--moss);margin-bottom:10px}
    .team-info p{font-size:.9rem;color:var(--muted);line-height:1.65;margin:0}
    .footer-strip{background:var(--brown);padding:28px 24px;text-align:center}
    .footer-strip p{font-size:.82rem;color:var(--sand);margin:0;letter-spacing:.06em}
    ::-webkit-scrollbar{width:4px}
    ::-webkit-scrollbar-track{background:var(--cream)}
    ::-webkit-scrollbar-thumb{background:var(--sand);border-radius:4px}
  </style>
</head>
<body>
  <section class="section s01">
    <div class="section-inner">
      <div class="doc-meta reveal">
        <span>${nomeLead}</span>
        <span>${dataFormatada}</span>
        <span class="badge-conf">Confidencial</span>
        <span>Preparado pela equipe Table Clinic</span>
      </div>
      <span class="section-num reveal">01 / 05</span>
      <div class="lead-name reveal">Para<br><em>${nomeLead}</em></div>
      <div class="divider-light reveal"></div>
      <p class="intro-text reveal">${s01Intro}</p>
    </div>
  </section>

  <section class="section s02">
    <div class="section-inner">
      <span class="section-num reveal">02 / 05</span>
      <h2 class="reveal">${s02Titulo}</h2>
      <div class="divider reveal"></div>
      ${s02Conteudo}
    </div>
  </section>

  <section class="section s03">
    <div class="section-inner">
      <span class="section-num reveal">03 / 05</span>
      <h2 class="reveal">${s03Titulo}</h2>
      <div class="divider reveal"></div>
      <p class="reveal" style="color:var(--muted)">Baseado no que você compartilhou, é isso que enxergamos como movimento inicial para o seu caso:</p>
      <ul class="steps-list">${stepsHTML}</ul>
    </div>
  </section>

  <section class="section s04">
    <div class="section-inner">
      <span class="section-num reveal">04 / 05</span>
      <h2 class="reveal">Sua jornada<br>em 3 meses</h2>
      <div class="divider reveal"></div>
      <p class="reveal" style="color:var(--muted);margin-bottom:0">Um processo real, com ritmo humano e suporte em cada etapa.</p>
      <div class="timeline">
        ${mesHTML(1, s04Mes1.titulo, s04Mes1.items, '')}
        ${mesHTML(2, s04Mes2.titulo, s04Mes2.items, 'm2')}
        ${mesHTML(3, s04Mes3.titulo, s04Mes3.items, 'm3')}
      </div>
      <div class="curve-wrap reveal">
        <span class="curve-label">Curva de bem-estar e paz com a comida</span>
        <svg class="curve-svg" viewBox="0 0 640 180" xmlns="http://www.w3.org/2000/svg">
          <line x1="60" y1="20" x2="60" y2="150" stroke="#DDD4C4" stroke-width="1"/>
          <line x1="60" y1="150" x2="600" y2="150" stroke="#DDD4C4" stroke-width="1"/>
          <line x1="60" y1="110" x2="600" y2="110" stroke="#DDD4C4" stroke-width="0.5" stroke-dasharray="4,4"/>
          <line x1="60" y1="70" x2="600" y2="70" stroke="#DDD4C4" stroke-width="0.5" stroke-dasharray="4,4"/>
          <line x1="220" y1="20" x2="220" y2="150" stroke="#DDD4C4" stroke-width="0.5" stroke-dasharray="4,4"/>
          <line x1="400" y1="20" x2="400" y2="150" stroke="#DDD4C4" stroke-width="0.5" stroke-dasharray="4,4"/>
          <text x="140" y="168" text-anchor="middle" font-family="Jost,sans-serif" font-size="10" fill="#7A6E64">Mês 1</text>
          <text x="310" y="168" text-anchor="middle" font-family="Jost,sans-serif" font-size="10" fill="#7A6E64">Mês 2</text>
          <text x="500" y="168" text-anchor="middle" font-family="Jost,sans-serif" font-size="10" fill="#7A6E64">Mês 3</text>
          <text x="50" y="153" text-anchor="end" font-family="Jost,sans-serif" font-size="9" fill="#7A6E64">baixo</text>
          <text x="50" y="113" text-anchor="end" font-family="Jost,sans-serif" font-size="9" fill="#7A6E64">médio</text>
          <text x="50" y="73" text-anchor="end" font-family="Jost,sans-serif" font-size="9" fill="#7A6E64">alto</text>
          <defs><linearGradient id="cg" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#B97040" stop-opacity="0.18"/><stop offset="100%" stop-color="#B97040" stop-opacity="0"/></linearGradient></defs>
          <path d="M60,148 C80,146 100,143 130,140 C160,137 185,143 220,136 C255,128 275,112 310,100 C345,88 368,88 400,76 C430,65 460,55 500,44 C530,36 568,30 600,26 L600,150 L60,150 Z" fill="url(#cg)"/>
          <path d="M60,148 C80,146 100,143 130,140 C160,137 185,143 220,136 C255,128 275,112 310,100 C345,88 368,88 400,76 C430,65 460,55 500,44 C530,36 568,30 600,26" fill="none" stroke="#B97040" stroke-width="2.5" stroke-linecap="round"/>
          <circle cx="60" cy="148" r="4" fill="#B97040"/>
          <circle cx="220" cy="136" r="4" fill="#4E5E42"/>
          <circle cx="400" cy="76" r="4" fill="#4E5E42"/>
          <circle cx="600" cy="26" r="4" fill="#3D4A35"/>
          <text x="605" y="24" font-family="Cormorant Garamond,serif" font-size="11" fill="#3D4A35" font-style="italic">paz e leveza</text>
        </svg>
      </div>
    </div>
  </section>

  <section class="section s05">
    <div class="section-inner">
      <span class="section-num reveal">05 / 05</span>
      <h2 class="reveal">Sua equipe</h2>
      <div class="divider reveal"></div>
      <p class="reveal" style="color:var(--muted)">Duas pessoas vão caminhar com você ao longo desses três meses, de perto e com suporte real.</p>
      <div class="team-grid">
        <div class="team-card reveal">
          <img class="team-photo" src="/fotos/evelyn-liu.png" alt="Evelyn Liu" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'"/>
          <div class="team-avatar">E</div>
          <div class="team-info">
            <span class="team-role">Fundadora e método</span>
            <h3>Evelyn Liu</h3>
            <p>Nutricionista comportamental e autora de "Gordura Não Existe: O que Existe é Dor". Criou o método que une o trabalho psicoemocional ao plano alimentar, tratando a raiz do problema em vez de só o sintoma.</p>
          </div>
        </div>
        <div class="team-card reveal">
          <img class="team-photo" src="${nutriFoto}" alt="${nutriNome}" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'"/>
          <div class="team-avatar">${nutriNome.charAt(0)}</div>
          <div class="team-info">
            <span class="team-role">${nutriRole}</span>
            <h3>${nutriNome}</h3>
            <p>${nutriBio}</p>
          </div>
        </div>
      </div>
    </div>
  </section>

  <div class="footer-strip">
    <p>Table Clinic &middot; Moema, São Paulo &middot; tableclinic.com.br</p>
  </div>

  <script>
    const obs = new IntersectionObserver((entries) => {
      entries.forEach(e => { if(e.isIntersecting){e.target.classList.add('visible');obs.unobserve(e.target);} });
    },{threshold:0.08,rootMargin:'0px 0px -40px 0px'});
    document.querySelectorAll('.reveal').forEach((el,i)=>{el.style.transitionDelay=((i%4)*0.07)+'s';obs.observe(el);});
  </script>
</body>
</html>`;
}
